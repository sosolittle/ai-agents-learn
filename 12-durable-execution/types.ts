import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Workflow steps
// ─────────────────────────────────────────────────────────────────────────────

// A closed, ordered enum. `.options` preserves declaration order, so this is
// the single source of truth for "what step comes next" — the runner never
// hardcodes the sequence a second time.
export const WorkflowStepSchema = z.enum([
  "validate_approval",
  "execute_refund",
  "send_confirmation",
]);
export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;
export const WORKFLOW_STEPS = WorkflowStepSchema.options;

// Intentionally small. There is no "crashed" status: a real abrupt crash never
// gets a chance to persist anything, so the truthful last-known state is
// whatever the workflow was in before the crash — usually "running".
export const WorkflowStatusSchema = z.enum(["running", "completed", "failed"]);
export type WorkflowStatus = z.infer<typeof WorkflowStatusSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Input: the approved action handed off by Module 11
// ─────────────────────────────────────────────────────────────────────────────

// The shape of what the previous control layer (human-in-the-loop approval)
// hands off. This is a STRUCTURAL contract only — it accepts "pending" and
// "rejected" too, because this module re-checks the business rule itself
// (defense in depth) rather than blindly trusting the caller. The strict
// business-rule check lives in steps.ts's validate_approval step.
export const ApprovalStatusSchema = z.enum(["pending", "approved", "rejected"]);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

export const ApprovedActionSchema = z
  .object({
    approvalId: z.string(),
    status: ApprovalStatusSchema,
    toolName: z.string(),
    arguments: z
      .object({
        orderId: z.string(),
        amount: z.number(),
        currency: z.string(),
        reason: z.string(),
      })
      .strict(),
  })
  .strict();
export type ApprovedAction = z.infer<typeof ApprovedActionSchema>;

// The flattened, persisted form of the input inside a workflow record. Also a
// structural contract — the business rules are re-checked by the
// validate_approval step every time it runs, whether that's the first run or a
// resume after a crash.
export const WorkflowInputSchema = z
  .object({
    approvalId: z.string(),
    approvalStatus: z.string(),
    toolName: z.string(),
    orderId: z.string(),
    amount: z.number(),
    currency: z.string(),
    reason: z.string(),
  })
  .strict();
export type WorkflowInput = z.infer<typeof WorkflowInputSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Workflow record (persisted checkpoint state)
// ─────────────────────────────────────────────────────────────────────────────

// Only what a completed step is allowed to have written. The context is built
// up incrementally as steps checkpoint — it never contains data from a step
// that has not yet completed.
export const WorkflowContextSchema = z
  .object({
    refundId: z.string().optional(),
    confirmationId: z.string().optional(),
  })
  .strict();
export type WorkflowContext = z.infer<typeof WorkflowContextSchema>;

// The durable checkpoint. `completedSteps` — not a `currentStep` pointer — is
// the source of truth for where to resume: it cannot drift out of sync with
// itself the way a separately-tracked pointer could.
//
// The base object type is exported separately from the refined schema below,
// so other schemas (and error messages) can talk about "a workflow record"
// without re-running the semantic checks every time.
const WorkflowRecordShape = z
  .object({
    id: z.string(),
    status: WorkflowStatusSchema,
    input: WorkflowInputSchema,
    completedSteps: z.array(WorkflowStepSchema),
    context: WorkflowContextSchema,
    createdAt: z.string(),
    updatedAt: z.string(),
    lastError: z.string().optional(),
  })
  .strict();

/** True only if `completed` is exactly a prefix of WORKFLOW_STEPS — no gaps, no repeats, no reordering. */
function isValidCompletedPrefix(completed: WorkflowStep[]): boolean {
  return completed.every((step, index) => WORKFLOW_STEPS[index] === step);
}

// This refinement is what makes a corrupted or hand-edited checkpoint fail to
// load instead of silently confusing the resume logic. `completedSteps`
// deciding "what's next" is only safe to trust if it can only ever be a valid
// prefix of the workflow definition.
export const WorkflowRecordSchema = WorkflowRecordShape.superRefine((record, ctx) => {
  if (!isValidCompletedPrefix(record.completedSteps)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["completedSteps"],
      message: "completedSteps must be an ordered prefix of the workflow definition",
    });
  }

  // The context must agree with which steps actually completed: a completed
  // step must have left its result behind. This is deliberately one
  // directional — an effect existing in the idempotency ledger does NOT
  // require the workflow context to know about it yet. That gap (the
  // provider knows before the checkpoint does) is the crash-window lesson
  // this module exists to demonstrate, so a record like
  // `{ completedSteps: ["validate_approval"], context: {} }` with a refund
  // effect already persisted elsewhere must stay valid.
  if (record.completedSteps.includes("execute_refund") && !record.context.refundId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["context", "refundId"],
      message: "execute_refund is completed but context.refundId is missing",
    });
  }
  if (record.completedSteps.includes("send_confirmation") && !record.context.confirmationId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["context", "confirmationId"],
      message: "send_confirmation is completed but context.confirmationId is missing",
    });
  }

  if (record.status === "completed") {
    const allStepsDone = WORKFLOW_STEPS.every((step) => record.completedSteps.includes(step));
    if (!allStepsDone) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["status"],
        message: 'status is "completed" but not every workflow step is in completedSteps',
      });
    }
  }
});
export type WorkflowRecord = z.infer<typeof WorkflowRecordShape>;

// ─────────────────────────────────────────────────────────────────────────────
// Idempotent side effects (the mock downstream providers' ledger)
// ─────────────────────────────────────────────────────────────────────────────

export const EffectTypeSchema = z.enum(["refund", "confirmation"]);
export type EffectType = z.infer<typeof EffectTypeSchema>;

export const RefundEffectResultSchema = z
  .object({
    refundId: z.string(),
    orderId: z.string(),
    amount: z.number(),
    currency: z.string(),
    status: z.literal("processed"),
    mock: z.literal(true),
  })
  .strict();
export type RefundEffectResult = z.infer<typeof RefundEffectResultSchema>;

export const ConfirmationEffectResultSchema = z
  .object({
    confirmationId: z.string(),
    orderId: z.string(),
    status: z.literal("sent"),
    mock: z.literal(true),
  })
  .strict();
export type ConfirmationEffectResult = z.infer<typeof ConfirmationEffectResultSchema>;

// A discriminated union keyed on `type`, so a refund record can never end up
// holding a confirmation-shaped result or vice versa. `step` is additionally
// pinned to a literal per branch — a refund effect can only ever be tagged
// "execute_refund" and a confirmation effect only "send_confirmation" — so an
// impossible record like `{ type: "refund", step: "send_confirmation" }`
// fails schema validation instead of quietly persisting. `key` is the
// idempotency key (e.g. "WF-001:execute_refund") — the mock provider's own
// lookup key, not just a workflow-side convenience field.
export const EffectRecordSchema = z.discriminatedUnion("type", [
  z
    .object({
      key: z.string(),
      workflowId: z.string(),
      step: z.literal("execute_refund"),
      type: z.literal("refund"),
      result: RefundEffectResultSchema,
      createdAt: z.string(),
    })
    .strict(),
  z
    .object({
      key: z.string(),
      workflowId: z.string(),
      step: z.literal("send_confirmation"),
      type: z.literal("confirmation"),
      result: ConfirmationEffectResultSchema,
      createdAt: z.string(),
    })
    .strict(),
]);
export type EffectRecord = z.infer<typeof EffectRecordSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Event log (lifecycle visibility)
// ─────────────────────────────────────────────────────────────────────────────

export const WorkflowEventTypeSchema = z.enum([
  "WORKFLOW_CREATED",
  "WORKFLOW_STARTED",
  "WORKFLOW_RESUMED",
  "STEP_STARTED",
  "STEP_COMPLETED",
  "STEP_FAILED",
  "SIDE_EFFECT_EXECUTED",
  "SIDE_EFFECT_REUSED",
  "WORKFLOW_COMPLETED",
]);
export type WorkflowEventType = z.infer<typeof WorkflowEventTypeSchema>;

export const WorkflowEventSchema = z
  .object({
    event: WorkflowEventTypeSchema,
    timestamp: z.string(),
    workflowId: z.string(),
    step: WorkflowStepSchema.optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();
export type WorkflowEvent = z.infer<typeof WorkflowEventSchema>;
