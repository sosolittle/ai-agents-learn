// ============================================================
//  Approval Service：人工审批生命周期的编排中心
//
//  学习目标：
//  1. 看懂提案如何经过策略后进入自动执行、待审批或拒绝
//  2. 掌握 pending → approved → executed / rejected 的状态迁移
//  3. 理解人工编辑只允许修改工具参数，并且必须重新校验
//  4. 通过执行记录完成重复执行拦截和崩溃恢复
//
//  注意：
//  本文件负责“按什么顺序调用各模块”，policy、storage、executor 各自仍保持
//  独立职责。编排层不是安全边界的唯一守门人，executor 还会再次检查。
// ============================================================

import { appendAudit } from "./auditLog.js";
import {
  findApproval,
  findExecutionByApprovalId,
  loadApprovals,
  nextApprovalId,
  upsertApproval,
} from "./approvalStore.js";
import type { DataPaths } from "./config.js";
import { executeAction, type ExecutionOutcome } from "./executor.js";
import { evaluatePolicy } from "./policy.js";
import {
  ActionProposalSchema,
  type ActionProposal,
  type ApprovalRecord,
  type PolicyResult,
  type ProposedAction,
} from "./types.js";
import { nowIso, writeJsonArray } from "./utils.js";

// The approval service is the orchestration layer. It ties together the model
// proposal, the policy gate, persistence, and execution — but each of those
// responsibilities lives in its own module. This file owns the lifecycle:
// propose → gate → (pending) → edit → approve/reject → execute-once → audit.

// Record fields a human editor must never be able to change through the edit
// command. Only tool arguments are editable; identity, status, timestamps, the
// chosen tool, and the execution link are off limits.
const PROTECTED_EDIT_FIELDS = new Set([
  "id",
  "status",
  "createdAt",
  "updatedAt",
  "toolName",
  "executionId",
  "decisionReason",
  "proposedAction",
  "originalRequest",
]);

// Argument fields that must be coerced from CLI strings to numbers before
// re-validation. Everything else stays a string.
const NUMERIC_ARG_FIELDS = new Set(["amount"]);

export type ProposalOutcome =
  | {
      kind: "auto_executed";
      record: ApprovalRecord;
      policy: PolicyResult;
      execution: ExecutionOutcome;
    }
  | {
      kind: "pending";
      record: ApprovalRecord;
      policy: PolicyResult;
      duplicateOf?: string;
    }
  | { kind: "denied"; policy: PolicyResult; toolName: ActionProposal["toolName"] };
// ProposalOutcome 是判别联合：
// - auto_executed 一定带 execution
// - pending 一定带 record，并可能指向 duplicateOf
// - denied 没有 approval record，因为禁止动作不会进入人工队列

function toProposedAction(proposal: ActionProposal): ProposedAction {
  // ApprovalRecord 只保存后续流程需要的动作信息，不把模型输出对象本身
  // 当成权限凭据；权限始终来自 policy 或人工状态迁移。
  return {
    toolName: proposal.toolName,
    arguments: proposal.arguments,
    reason: proposal.reason,
  };
}

function argumentsEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  // 本例参数来自严格 Schema，字段顺序稳定，因此 JSON 字符串比较足够直观。
  // 生产环境可改用 canonical JSON 或业务幂等键，不能依赖任意对象的键顺序。
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Take a validated model proposal and route it through the policy gate.
 *
 * - `deny`  → audited and refused. No record is created; the tool is never
 *   reachable.
 * - `auto_execute` → executed immediately and recorded as executed.
 * - `require_approval` → a pending approval record is persisted for a human.
 *   If an identical pending approval already exists for the same request, it is
 *   reused rather than duplicated (so re-running the demo does not pile up
 *   copies).
 *
 * The proposal is re-validated here even though it is already typed, so this
 * function is safe to call with data loaded from disk or built in a test.
 */
export function handleProposal(
  paths: DataPaths,
  originalRequest: string,
  rawProposal: unknown
): ProposalOutcome {
  // 第 1 道运行时边界：即使调用方在 TypeScript 中声明了正确类型，
  // 这里仍把传入值视为 unknown 并重新校验，防止磁盘/网络/测试伪造数据。
  const proposal = ActionProposalSchema.parse(rawProposal);
  const proposedAction = toProposedAction(proposal);

  // 先记录模型提出了什么，再记录系统如何判定，审计日志才能还原完整因果链。
  appendAudit(paths, {
    event: "ACTION_PROPOSED",
    toolName: proposal.toolName,
    metadata: { originalRequest, arguments: proposal.arguments },
  });

  const policy = evaluatePolicy(proposal.toolName);
  appendAudit(paths, {
    event: "POLICY_EVALUATED",
    toolName: proposal.toolName,
    metadata: { decision: policy.decision, reason: policy.reason },
  });

  if (policy.decision === "deny") {
    // Forbidden: no executable record is ever created. Record an explicit
    // denial event so the refusal is visible in the audit trail.
    appendAudit(paths, {
      event: "ACTION_DENIED",
      toolName: proposal.toolName,
      metadata: { originalRequest, reason: policy.reason },
    });
    return { kind: "denied", policy, toolName: proposal.toolName };
  }

  if (policy.decision === "auto_execute") {
    // The policy itself authorizes this action, so it goes straight to
    // `approved` — but NOT to `executed` until the tool actually succeeds. If
    // execution throws, the record truthfully stays `approved`, never falsely
    // `executed`.
    const now = nowIso();
    const approved: ApprovalRecord = {
      id: nextApprovalId(paths),
      originalRequest,
      proposedAction,
      status: "approved",
      createdAt: now,
      updatedAt: now,
    };
    upsertApproval(paths, approved);
    // auto_execute 不是“绕过审批状态机”，而是由 policy 充当授权者。
    // 因此仍先落盘 approved，再执行，失败时状态不会谎称 executed。
    appendAudit(paths, {
      event: "ACTION_APPROVED",
      approvalId: approved.id,
      toolName: approved.proposedAction.toolName,
      metadata: { authorizedBy: "policy" },
    });

    const execution = executeAction(paths, approved);
    const executed: ApprovalRecord = {
      ...approved,
      status: "executed",
      executionId: execution.executionId,
      updatedAt: nowIso(),
    };
    upsertApproval(paths, executed);
    return { kind: "auto_executed", record: executed, policy, execution };
  }

  // require_approval: reuse an identical pending record if one already exists.
  // 只复用 pending：已经 rejected/executed 的历史记录代表一次完成的决策，
  // 新请求不应偷偷复活旧记录，而应该创建新的审批上下文。
  const duplicate = loadApprovals(paths).find(
    (existing) =>
      existing.status === "pending" &&
      existing.originalRequest === originalRequest &&
      existing.proposedAction.toolName === proposedAction.toolName &&
      argumentsEqual(existing.proposedAction.arguments, proposedAction.arguments)
  );
  if (duplicate) {
    // 重复 pending 不再写 APPROVAL_REQUESTED，避免审计日志表现得像创建了
    // 一张新审批单；调用方通过 duplicateOf 明确知道复用了哪一张。
    return { kind: "pending", record: duplicate, policy, duplicateOf: duplicate.id };
  }

  const now = nowIso();
  const record: ApprovalRecord = {
    id: nextApprovalId(paths),
    originalRequest,
    proposedAction,
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };
  upsertApproval(paths, record);

  appendAudit(paths, {
    event: "APPROVAL_REQUESTED",
    approvalId: record.id,
    toolName: record.proposedAction.toolName,
  });

  return { kind: "pending", record, policy };
}

export interface EditResult {
  record: ApprovalRecord;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}

/**
 * Edit the arguments of a pending approval.
 *
 * The edit is a human business decision (for example, deciding a €49 partial
 * refund is appropriate), not a model correction. Only tool arguments may
 * change; protected record fields are rejected. The merged arguments are
 * re-validated against the tool schema, so an invalid edit (a negative amount,
 * an unknown field) fails before it is saved. The record stays pending.
 */
export function editApproval(
  paths: DataPaths,
  id: string,
  edits: Record<string, string>
): EditResult {
  // requirePending 同时完成“记录存在”和“当前仍可编辑”两个前置条件检查。
  const record = requirePending(paths, id, "edit");

  for (const key of Object.keys(edits)) {
    if (PROTECTED_EDIT_FIELDS.has(key)) {
      throw new Error(
        `Cannot edit protected field "${key}". Only tool arguments may be edited.`
      );
    }
  }

  const before = { ...record.proposedAction.arguments };
  // before/after 会进入审计日志，使审核人对金额、理由等修改可追溯。

  // Merge the edits over the current arguments, coercing numeric fields.
  const mergedArgs: Record<string, unknown> = { ...before };
  for (const [key, value] of Object.entries(edits)) {
    mergedArgs[key] = NUMERIC_ARG_FIELDS.has(key) ? coerceNumber(key, value) : value;
  }

  // Re-validate the whole action. A bad edit (negative amount, wrong currency,
  // unknown field) throws here and nothing is persisted.
  const revalidated = ActionProposalSchema.parse({
    toolName: record.proposedAction.toolName,
    arguments: mergedArgs,
    reason: record.proposedAction.reason,
  });
  // 先完成全部校验，再 upsert。任何异常都会在写盘前抛出，
  // 所以失败的编辑不会留下半更新记录。

  const updated: ApprovalRecord = {
    ...record,
    proposedAction: toProposedAction(revalidated),
    updatedAt: nowIso(),
  };
  upsertApproval(paths, updated);

  appendAudit(paths, {
    event: "ACTION_EDITED",
    approvalId: updated.id,
    toolName: updated.proposedAction.toolName,
    metadata: { before, after: updated.proposedAction.arguments },
  });

  return { record: updated, before, after: updated.proposedAction.arguments };
}

export interface ApproveResult {
  record: ApprovalRecord;
  execution?: ExecutionOutcome;
  blocked: boolean;
}

/**
 * Approve a pending record: grant permission, then execute its tool once.
 *
 * State transition: `pending → approved → executed`. Permission is granted
 * (and persisted as `approved`) BEFORE the tool runs, and the record only
 * becomes `executed` after the tool succeeds — so the state is always truthful.
 *
 * Idempotency / recovery:
 *  - a record already `executed` blocks the duplicate (DUPLICATE_EXECUTION_BLOCKED);
 *  - if an execution already exists for this approval (e.g. a crash between
 *    saving the execution and flipping the status), the existing result is
 *    reconciled and reused instead of running the tool again.
 *
 * Before granting approval, the action is re-validated and the policy is
 * re-evaluated: the tool must still be classified exactly `require_approval`, so
 * a policy that drifted to `deny` or `auto_execute` cannot execute through this
 * stored workflow.
 */
export function approveApproval(paths: DataPaths, id: string): ApproveResult {
  const record = requireExisting(paths, id);

  // Idempotency guard: already executed → block the duplicate, do not re-run.
  // 这是最常见的重复点击/重复命令路径：审批单已经明确指向 executionId。
  if (record.status === "executed") {
    appendAudit(paths, {
      event: "DUPLICATE_EXECUTION_BLOCKED",
      approvalId: record.id,
      toolName: record.proposedAction.toolName,
      metadata: { executionId: record.executionId },
    });
    return { record, blocked: true };
  }

  // Recovery: an execution already exists but the record never advanced to
  // `executed`. Reconcile the record and reuse the existing result.
  // 这处理一个很窄但很重要的崩溃窗口：
  // saveExecution 成功 → 进程崩溃 → approval 尚未更新为 executed。
  const priorExecution = findExecutionByApprovalId(paths, record.id);
  if (priorExecution) {
    const reconciled: ApprovalRecord = {
      ...record,
      status: "executed",
      executionId: priorExecution.id,
      updatedAt: nowIso(),
    };
    upsertApproval(paths, reconciled);
    appendAudit(paths, {
      event: "EXISTING_EXECUTION_RECOVERED",
      approvalId: record.id,
      toolName: record.proposedAction.toolName,
      metadata: { executionId: priorExecution.id },
    });
    return {
      record: reconciled,
      execution: {
        executionId: priorExecution.id,
        result: priorExecution.result,
        recovered: true,
      },
      blocked: false,
    };
  }

  if (record.status !== "pending") {
    // rejected 不能被原地改回 approved；若业务需要重新申请，应生成新记录，
    // 这样旧的拒绝决定仍完整保留在历史中。
    throw new Error(
      `Approval ${id} is "${record.status}", not "pending". It cannot be approved.`
    );
  }

  // Re-validate the action and re-evaluate the policy at approval time.
  ActionProposalSchema.parse({
    toolName: record.proposedAction.toolName,
    arguments: record.proposedAction.arguments,
    reason: record.proposedAction.reason,
  });
  // 审批时再次校验是必要的：pending 记录可能等待了很久，也可能被外部系统
  // 修改过。不能因为“创建时合法”就假设“执行时仍合法”。

  // The stored workflow must still match the current policy exactly. If the
  // tool is no longer `require_approval`, the human-approval path is invalid.
  const policy = evaluatePolicy(record.proposedAction.toolName);
  if (policy.decision !== "require_approval") {
    throw new Error(
      `Approval ${id} cannot continue because "${record.proposedAction.toolName}" is no longer classified as require_approval (now "${policy.decision}").`
    );
  }

  // Grant permission first: pending → approved.
  const approved: ApprovalRecord = {
    ...record,
    status: "approved",
    updatedAt: nowIso(),
  };
  upsertApproval(paths, approved);
  // 先持久化授权，再调用工具。若工具失败，记录停留在 approved，
  // 准确表达“已获准但尚未完成”，便于后续重试或人工处置。
  appendAudit(paths, {
    event: "ACTION_APPROVED",
    approvalId: approved.id,
    toolName: approved.proposedAction.toolName,
    metadata: { authorizedBy: "human" },
  });

  // Execute from the approved record. The executor defends the boundary again.
  const execution = executeAction(paths, approved);

  const executed: ApprovalRecord = {
    ...approved,
    status: "executed",
    executionId: execution.executionId,
    updatedAt: nowIso(),
  };
  upsertApproval(paths, executed);

  return { record: executed, execution, blocked: false };
}

/**
 * Reject a pending approval with a reason. The tool is never executed, and the
 * record can no longer be approved unless a new approval is created.
 */
export function rejectApproval(
  paths: DataPaths,
  id: string,
  reason: string
): ApprovalRecord {
  // 拒绝理由属于审计上下文，因此不允许空字符串。
  if (!reason || reason.trim() === "") {
    throw new Error('A rejection reason is required (use --reason="...").');
  }
  const record = requirePending(paths, id, "reject");

  const rejected: ApprovalRecord = {
    ...record,
    status: "rejected",
    decisionReason: reason,
    updatedAt: nowIso(),
  };
  upsertApproval(paths, rejected);

  appendAudit(paths, {
    event: "ACTION_REJECTED",
    approvalId: rejected.id,
    toolName: rejected.proposedAction.toolName,
    metadata: { reason },
  });

  return rejected;
}

/** Restore a clean, empty demo state across all three stores. */
export function resetDemo(paths: DataPaths): void {
  // reset 只用于学习环境清空三个 JSON store；生产系统不应提供这种无条件
  // 清空审计记录的能力。
  writeJsonArray(paths.approvals, []);
  writeJsonArray(paths.audit, []);
  writeJsonArray(paths.executions, []);
}

// ── internal helpers ─────────────────────────────────────────────────────────

function requireExisting(paths: DataPaths, id: string): ApprovalRecord {
  // 将重复的前置条件集中在内部 helper，保证 edit/approve/reject 的
  // “找不到记录”错误信息一致。
  const record = findApproval(paths, id);
  if (!record) {
    throw new Error(`No approval found with id "${id}".`);
  }
  return record;
}

function requirePending(
  paths: DataPaths,
  id: string,
  action: string
): ApprovalRecord {
  const record = requireExisting(paths, id);
  if (record.status !== "pending") {
    throw new Error(
      `Cannot ${action} approval ${id}: it is "${record.status}", not "pending".`
    );
  }
  return record;
}

function coerceNumber(field: string, value: string): number {
  // CLI 参数天然是字符串；这里只做最小类型转换，真正的正数/字段范围校验
  // 仍由 ActionProposalSchema 和工具层完成。
  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`Field "${field}" must be a number, got "${value}".`);
  }
  return parsed;
}
