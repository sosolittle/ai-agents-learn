import { appendAudit } from "./auditLog.js";
import {
  findApproval,
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

function toProposedAction(proposal: ActionProposal): ProposedAction {
  return {
    toolName: proposal.toolName,
    arguments: proposal.arguments,
    reason: proposal.reason,
  };
}

function argumentsEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
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
  const proposal = ActionProposalSchema.parse(rawProposal);
  const proposedAction = toProposedAction(proposal);

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
    // Forbidden: no executable record is ever created.
    return { kind: "denied", policy, toolName: proposal.toolName };
  }

  if (policy.decision === "auto_execute") {
    const now = nowIso();
    const record: ApprovalRecord = {
      id: nextApprovalId(paths),
      originalRequest,
      proposedAction,
      status: "executed",
      createdAt: now,
      updatedAt: now,
    };
    upsertApproval(paths, record);
    const execution = executeAction(paths, record);
    const executed: ApprovalRecord = {
      ...record,
      status: "executed",
      executionId: execution.executionId,
      updatedAt: nowIso(),
    };
    upsertApproval(paths, executed);
    return { kind: "auto_executed", record: executed, policy, execution };
  }

  // require_approval: reuse an identical pending record if one already exists.
  const duplicate = loadApprovals(paths).find(
    (existing) =>
      existing.status === "pending" &&
      existing.originalRequest === originalRequest &&
      existing.proposedAction.toolName === proposedAction.toolName &&
      argumentsEqual(existing.proposedAction.arguments, proposedAction.arguments)
  );
  if (duplicate) {
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
  const record = requirePending(paths, id, "edit");

  for (const key of Object.keys(edits)) {
    if (PROTECTED_EDIT_FIELDS.has(key)) {
      throw new Error(
        `Cannot edit protected field "${key}". Only tool arguments may be edited.`
      );
    }
  }

  const before = { ...record.proposedAction.arguments };

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
 * Approve a pending record and execute its tool exactly once.
 *
 * Idempotency: a record already in the `executed` state is never executed
 * again. A duplicate approval is audited as DUPLICATE_EXECUTION_BLOCKED and the
 * record is returned unchanged, still `executed`. Before executing, the action
 * is re-validated and the policy is re-evaluated, so a record whose tool became
 * denied, or whose arguments drifted, cannot execute.
 */
export function approveApproval(paths: DataPaths, id: string): ApproveResult {
  const record = requireExisting(paths, id);

  // Idempotency guard: already executed → block the duplicate, do not re-run.
  if (record.status === "executed") {
    appendAudit(paths, {
      event: "DUPLICATE_EXECUTION_BLOCKED",
      approvalId: record.id,
      toolName: record.proposedAction.toolName,
      metadata: { executionId: record.executionId },
    });
    return { record, blocked: true };
  }

  if (record.status !== "pending") {
    throw new Error(
      `Approval ${id} is "${record.status}", not "pending". It cannot be approved.`
    );
  }

  // Re-validate the action and re-evaluate the policy at execution time.
  ActionProposalSchema.parse({
    toolName: record.proposedAction.toolName,
    arguments: record.proposedAction.arguments,
    reason: record.proposedAction.reason,
  });

  const policy = evaluatePolicy(record.proposedAction.toolName);
  if (policy.decision === "deny") {
    throw new Error(
      `Approval ${id} cannot be executed: "${record.proposedAction.toolName}" is denied by policy.`
    );
  }

  appendAudit(paths, {
    event: "ACTION_APPROVED",
    approvalId: record.id,
    toolName: record.proposedAction.toolName,
  });

  const execution = executeAction(paths, record);

  const executed: ApprovalRecord = {
    ...record,
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
  writeJsonArray(paths.approvals, []);
  writeJsonArray(paths.audit, []);
  writeJsonArray(paths.executions, []);
}

// ── internal helpers ─────────────────────────────────────────────────────────

function requireExisting(paths: DataPaths, id: string): ApprovalRecord {
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
  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`Field "${field}" must be a number, got "${value}".`);
  }
  return parsed;
}
