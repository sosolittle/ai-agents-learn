import {
  findWorkflow,
  findWorkflowByApprovalId,
  nextWorkflowId,
  upsertWorkflow,
} from "./checkpointStore.js";
import type { DataPaths } from "./config.js";
import { appendEvent } from "./eventLog.js";
import { mockConfirmationProvider, mockRefundProvider, validateApproval } from "./steps.js";
import {
  ApprovedActionSchema,
  WORKFLOW_STEPS,
  type ApprovedAction,
  type WorkflowContext,
  type WorkflowInput,
  type WorkflowRecord,
  type WorkflowStep,
} from "./types.js";
import { nowIso } from "./utils.js";

// Orchestration and resume semantics. This is the only file that decides
// sequencing, checkpointing, and where a workflow resumes from. Every step's
// actual work lives in steps.ts; this file just calls it in order and
// persists a checkpoint after each one succeeds.

/**
 * Thrown to simulate an abrupt process crash (e.g. the container is killed,
 * the process is OOM-killed, the machine loses power). It is deliberately NOT
 * a business failure: the workflow record is left exactly as it was last
 * checkpointed, and the caller is expected to catch this, print the crash, and
 * stop — not mark anything as failed. A real crash would never get the chance
 * to run a catch block at all; throwing here just gives the demonstration a
 * controlled place to stop.
 */
export class SimulatedCrashError extends Error {
  constructor(step: WorkflowStep) {
    super(
      `Simulated process crash after the side effect for "${step}" succeeded, ` +
        "before the checkpoint for that step was saved."
    );
    this.name = "SimulatedCrashError";
  }
}

export interface RunnerOptions {
  /**
   * Throw a SimulatedCrashError immediately after this step's side effect
   * succeeds, before the step is checkpointed. This is the dangerous window
   * the whole module exists to demonstrate: the external effect already
   * happened, but the workflow does not know it yet.
   */
  crashAfterSideEffectStep?: WorkflowStep;
}

export interface RunResult {
  workflow: WorkflowRecord;
  /** True when the workflow was already completed and nothing ran. */
  noop?: boolean;
}

function toWorkflowInput(approvedAction: ApprovedAction): WorkflowInput {
  return {
    approvalId: approvedAction.approvalId,
    approvalStatus: approvedAction.status,
    toolName: approvedAction.toolName,
    orderId: approvedAction.arguments.orderId,
    amount: approvedAction.arguments.amount,
    currency: approvedAction.arguments.currency,
    reason: approvedAction.arguments.reason,
  };
}

export interface CreateWorkflowResult {
  workflow: WorkflowRecord;
  /** True when an existing workflow for this approval was returned instead of a new one. */
  reused: boolean;
}

/**
 * Create a workflow from an approved action, or return the existing one.
 *
 * The approval ID is treated as the business identity of the authorized
 * action — it is a different boundary from the step-level idempotency key
 * (`WF-001:execute_refund`):
 *
 *   - approval identity  → prevents the SAME approval from starting a SECOND
 *     workflow (and therefore a second, independent refund).
 *   - workflow-step identity → prevents a RETRY of an EXISTING workflow's
 *     step from repeating that step's side effect.
 *
 * Without this guard, resubmitting APR-001 (e.g. a retried request, a second
 * click) would create WF-001 and WF-002, and each would have its own
 * `WF-00N:execute_refund` key — two legitimate-looking refunds for one
 * approval. This is checked before allocating a new workflow ID, so a repeat
 * submission never even consumes an ID.
 *
 * The action is structurally validated here (right shape, right primitive
 * types) but NOT business-validated — that happens inside the
 * validate_approval step itself, every time it runs.
 */
export function createWorkflow(
  paths: DataPaths,
  rawApprovedAction: unknown
): CreateWorkflowResult {
  const approvedAction = ApprovedActionSchema.parse(rawApprovedAction);

  const existing = findWorkflowByApprovalId(paths, approvedAction.approvalId);
  if (existing) {
    return { workflow: existing, reused: true };
  }

  const id = nextWorkflowId(paths);
  const now = nowIso();

  const record: WorkflowRecord = {
    id,
    status: "running",
    input: toWorkflowInput(approvedAction),
    completedSteps: [],
    context: {},
    createdAt: now,
    updatedAt: now,
  };

  upsertWorkflow(paths, record);
  appendEvent(paths, { event: "WORKFLOW_CREATED", workflowId: id });
  return { workflow: record, reused: false };
}

/** The first step not yet in completedSteps. Undefined once every step is done. */
function nextIncompleteStep(record: WorkflowRecord): WorkflowStep | undefined {
  return WORKFLOW_STEPS.find((step) => !record.completedSteps.includes(step));
}

function requireWorkflow(paths: DataPaths, id: string): WorkflowRecord {
  const record = findWorkflow(paths, id);
  if (!record) {
    throw new Error(
      `No workflow found with id "${id}". Create one first with "npm start" or "npm run crash".`
    );
  }
  return record;
}

function checkpointStep(
  paths: DataPaths,
  record: WorkflowRecord,
  step: WorkflowStep,
  contextPatch: Partial<WorkflowContext>
): WorkflowRecord {
  const updated: WorkflowRecord = {
    ...record,
    completedSteps: [...record.completedSteps, step],
    context: { ...record.context, ...contextPatch },
    updatedAt: nowIso(),
  };
  // The checkpoint write. Everything before this point (side effects included)
  // could vanish with the process; everything after it is durable.
  upsertWorkflow(paths, updated);
  appendEvent(paths, { event: "STEP_COMPLETED", workflowId: record.id, step });
  return updated;
}

function markCompleted(paths: DataPaths, record: WorkflowRecord): WorkflowRecord {
  const completed: WorkflowRecord = { ...record, status: "completed", updatedAt: nowIso() };
  upsertWorkflow(paths, completed);
  appendEvent(paths, { event: "WORKFLOW_COMPLETED", workflowId: record.id });
  return completed;
}

function markFailed(paths: DataPaths, record: WorkflowRecord, error: Error): void {
  // A real step error (bad input, unsupported currency, ...) is a business
  // failure the running process is alive to record — unlike a simulated
  // crash, which never reaches this function.
  const failed: WorkflowRecord = {
    ...record,
    status: "failed",
    lastError: error.message,
    updatedAt: nowIso(),
  };
  upsertWorkflow(paths, failed);
}

function runStep(
  paths: DataPaths,
  record: WorkflowRecord,
  step: WorkflowStep,
  options: RunnerOptions
): WorkflowRecord {
  appendEvent(paths, { event: "STEP_STARTED", workflowId: record.id, step });

  try {
    switch (step) {
      case "validate_approval": {
        // Pure and side-effect free: no refund and no confirmation are
        // possible until this passes.
        validateApproval(record.input);
        return checkpointStep(paths, record, step, {});
      }

      case "execute_refund": {
        const { result, reused } = mockRefundProvider(paths, record.id, record.input);
        appendEvent(paths, {
          event: reused ? "SIDE_EFFECT_REUSED" : "SIDE_EFFECT_EXECUTED",
          workflowId: record.id,
          step,
          metadata: { refundId: result.refundId, idempotencyKey: `${record.id}:${step}` },
        });

        // THE dangerous window: the refund provider has already created
        // REF-001. If the process dies right here, the checkpoint below never
        // runs, and the next call still sees execute_refund as incomplete.
        if (options.crashAfterSideEffectStep === step) {
          throw new SimulatedCrashError(step);
        }

        return checkpointStep(paths, record, step, { refundId: result.refundId });
      }

      case "send_confirmation": {
        const { result, reused } = mockConfirmationProvider(paths, record.id, record.input);
        appendEvent(paths, {
          event: reused ? "SIDE_EFFECT_REUSED" : "SIDE_EFFECT_EXECUTED",
          workflowId: record.id,
          step,
          metadata: {
            confirmationId: result.confirmationId,
            idempotencyKey: `${record.id}:${step}`,
          },
        });

        if (options.crashAfterSideEffectStep === step) {
          throw new SimulatedCrashError(step);
        }

        return checkpointStep(paths, record, step, { confirmationId: result.confirmationId });
      }

      default: {
        const exhaustive: never = step;
        throw new Error(`Unhandled workflow step: ${JSON.stringify(exhaustive)}`);
      }
    }
  } catch (error) {
    if (error instanceof SimulatedCrashError) {
      // Not a business failure — the workflow stays exactly at its last
      // checkpoint (status stays "running"). Let it propagate; the caller
      // decides what a crashed process does next (nothing, until it resumes).
      throw error;
    }
    const err = error as Error;
    appendEvent(paths, {
      event: "STEP_FAILED",
      workflowId: record.id,
      step,
      metadata: { error: err.message },
    });
    markFailed(paths, record, err);
    throw err;
  }
}

function advance(
  paths: DataPaths,
  workflowId: string,
  options: RunnerOptions,
  startEvent: "WORKFLOW_STARTED" | "WORKFLOW_RESUMED"
): RunResult {
  const record = requireWorkflow(paths, workflowId);

  if (record.status === "completed") {
    // Resuming a completed workflow must never repeat a side effect: it is a
    // pure no-op, and it is not even worth an event.
    return { workflow: record, noop: true };
  }

  if (record.status === "failed") {
    throw new Error(
      `Workflow ${workflowId} previously failed and cannot be resumed automatically: ${record.lastError}. ` +
        "Fix the input and create a new workflow."
    );
  }

  appendEvent(paths, { event: startEvent, workflowId });

  // completedSteps — not a separately tracked "currentStep" pointer — decides
  // where to resume. That way there is nothing for the two to disagree about.
  let current = record;
  while (true) {
    const step = nextIncompleteStep(current);
    if (!step) {
      current = markCompleted(paths, current);
      break;
    }
    current = runStep(paths, current, step, options);
  }
  return { workflow: current };
}

/** Run a freshly created workflow from its first incomplete step. */
export function runWorkflow(
  paths: DataPaths,
  workflowId: string,
  options: RunnerOptions = {}
): RunResult {
  return advance(paths, workflowId, options, "WORKFLOW_STARTED");
}

/**
 * Resume a workflow after a restart. This reloads the record fresh from disk
 * on every call (via requireWorkflow -> findWorkflow) — there is no in-memory
 * workflow object carried over from a previous run to reuse.
 */
export function resumeWorkflow(
  paths: DataPaths,
  workflowId: string,
  options: RunnerOptions = {}
): RunResult {
  return advance(paths, workflowId, options, "WORKFLOW_RESUMED");
}
