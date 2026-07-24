// ============================================================
//  Executor：副作用发生前的最后一道安全门
//
//  学习目标：
//  1. 不信任上游已检查过的结论，在执行边界再次校验策略和状态
//  2. 用 approvalId 查找已有执行，阻止重复副作用
//  3. 区分“本地幂等恢复”和“分布式 exactly-once”
//  4. 只在工具成功后写入执行记录和 ACTION_EXECUTED
// ============================================================

import { appendAudit } from "./auditLog.js";
import {
  findExecutionByApprovalId,
  nextExecutionId,
  nextResultId,
  saveExecution,
} from "./approvalStore.js";
import type { DataPaths } from "./config.js";
import { evaluatePolicy } from "./policy.js";
import { RESULT_ID_PREFIX, runTool } from "./tools.js";
import type { ApprovalRecord } from "./types.js";
import { nowIso } from "./utils.js";

export interface ExecutionOutcome {
  executionId: string;
  result: Record<string, unknown>;
  // true when an existing execution for this approval was reused instead of
  // running the tool again.
  recovered: boolean;
}

/**
 * Execute the tool behind a record exactly once (locally) and record it.
 *
 * This is the last gate before a side effect, and it defends the control
 * boundary independently of the approval service — a direct call cannot bypass
 * it:
 *
 *  1. a tool denied by policy never executes;
 *  2. an approval-required tool only executes from an `approved` record — a
 *     pending or rejected record is refused here, not just in the service;
 *  3. if an execution already exists for this approval, the tool is NOT called
 *     again; the existing result is reused (local idempotency by approval ID).
 *
 * This is local idempotency, not a distributed exactly-once guarantee.
 */
export function executeAction(
  paths: DataPaths,
  approval: ApprovalRecord
): ExecutionOutcome {
  const { toolName, arguments: args } = approval.proposedAction;
  const policy = evaluatePolicy(toolName);
  // 不接收调用方传入的 policy 结果，而是根据 toolName 现场重新计算，
  // 避免调用方伪造或复用已经过期的授权结论。

  // Boundary 1: forbidden tools never execute.
  if (policy.decision === "deny") {
    throw new Error(
      `Refusing to execute "${toolName}": denied by policy. ${policy.reason}`
    );
  }

  // Boundary 2: approval-required tools must come from an approved record.
  // A pending or rejected record can never reach a tool through the executor.
  if (policy.decision === "require_approval" && approval.status !== "approved") {
    throw new Error(
      `Refusing to execute "${toolName}": human approval is required and the record is "${approval.status}", not "approved".`
    );
  }

  // Boundary 3 (local idempotency): reuse an existing execution for this
  // approval. The execution record is the durable proof the tool already ran.
  const existing = findExecutionByApprovalId(paths, approval.id);
  if (existing) {
    appendAudit(paths, {
      event: "EXISTING_EXECUTION_RECOVERED",
      approvalId: approval.id,
      toolName,
      metadata: { executionId: existing.id },
    });
    return { executionId: existing.id, result: existing.result, recovered: true };
  }

  const executionId = nextExecutionId(paths);
  const resultId = nextResultId(paths, RESULT_ID_PREFIX[toolName], toolName);
  // executionId 标识“这次工具运行”；resultId 标识业务结果（如退款单）。
  // 两者分开可以让工作流记录与下游业务记录各自拥有稳定标识。

  // runTool re-validates the arguments against the tool schema before calling.
  const result = runTool(toolName, args, resultId);

  saveExecution(paths, {
    id: executionId,
    approvalId: approval.id,
    toolName,
    arguments: args,
    result,
    executedAt: nowIso(),
  });
  // 先持久化执行结果，再写审计事件。之后审批服务会把 approval 状态推进
  // 到 executed；若进程恰好在中间崩溃，重试时会通过 execution 记录恢复。

  appendAudit(paths, {
    event: "ACTION_EXECUTED",
    approvalId: approval.id,
    toolName,
    metadata: { executionId, result },
  });

  return { executionId, result, recovered: false };
}
