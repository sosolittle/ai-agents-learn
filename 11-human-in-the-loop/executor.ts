import { appendAudit } from "./auditLog.js";
import {
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
}

/**
 * Execute the tool behind an approved record exactly once and record it.
 *
 * This is the last gate before a side effect. Even though the approve flow has
 * already checked the policy, the executor checks again — defense in depth, so a
 * denied tool can never be run through a direct executor call. It then allocates
 * a persisted execution ID, runs the mock tool, saves the execution, and writes
 * the ACTION_EXECUTED audit event.
 *
 * Idempotency lives one layer up on the approval status (a record already in the
 * `executed` state is never re-executed); this function performs the single
 * real call.
 */
export function executeAction(
  paths: DataPaths,
  approval: ApprovalRecord
): ExecutionOutcome {
  const { toolName, arguments: args } = approval.proposedAction;

  const policy = evaluatePolicy(toolName);
  if (policy.decision === "deny") {
    throw new Error(
      `Refusing to execute "${toolName}": denied by policy. ${policy.reason}`
    );
  }

  const executionId = nextExecutionId(paths);
  const resultId = nextResultId(paths, RESULT_ID_PREFIX[toolName], toolName);

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

  appendAudit(paths, {
    event: "ACTION_EXECUTED",
    approvalId: approval.id,
    toolName,
    metadata: { executionId, result },
  });

  return { executionId, result };
}
