import { z } from "zod";

import type { DataPaths } from "./config.js";
import { appendEffect, findEffectByKey, idempotencyKey, nextEffectId } from "./effectStore.js";
import type { ConfirmationEffectResult, RefundEffectResult, WorkflowInput } from "./types.js";
import { nowIso } from "./utils.js";

// Step implementations. Each workflow step lives here as a plain function —
// the runner (workflowRunner.ts) is responsible for sequencing, checkpointing,
// and crash injection; this file only knows how to do one unit of work.

// ─────────────────────────────────────────────────────────────────────────────
// validate_approval — pure, side-effect free
// ─────────────────────────────────────────────────────────────────────────────

// The business-rule check. This is deliberately stricter than WorkflowInputSchema
// (types.ts), which only proves "these fields exist with the right primitive
// types" — a pending or rejected approval passes that structural check just
// fine. This schema is what actually decides whether execution may proceed,
// and it runs every time the step runs, including after a resume.
const ValidatedRefundInputSchema = z
  .object({
    approvalId: z.string().regex(/^APR-\d+$/, 'approvalId must look like "APR-001"'),
    approvalStatus: z.literal("approved", {
      errorMap: () => ({ message: 'approvalStatus must be "approved"' }),
    }),
    toolName: z.literal("refundOrder", {
      errorMap: () => ({ message: 'toolName must be "refundOrder"' }),
    }),
    orderId: z.string().regex(/^ORD-\d+$/, 'orderId must look like "ORD-001"'),
    amount: z.number().positive("amount must be greater than 0"),
    currency: z.literal("EUR", { errorMap: () => ({ message: 'currency must be "EUR"' }) }),
    reason: z.string().min(1, "reason must be non-empty"),
  })
  .strict();

/**
 * Verify the approved action is actually allowed to execute. Pure and
 * side-effect free — no refund and no confirmation are possible until this
 * passes. Throws with a readable message on any violation; the runner turns
 * that into a `failed` workflow, not a retryable crash.
 */
export function validateApproval(input: WorkflowInput): void {
  const result = ValidatedRefundInputSchema.safeParse(input);
  if (!result.success) {
    const message = result.error.issues.map((issue) => issue.message).join("; ");
    throw new Error(`Approval validation failed: ${message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Side-effecting steps — idempotent at the provider boundary
// ─────────────────────────────────────────────────────────────────────────────

export interface SideEffectOutcome<T> {
  result: T;
  reused: boolean;
}

/**
 * Mock refund provider. The idempotency check happens here, at the side-effect
 * boundary itself — not by wrapping the call in `if (!completedSteps.includes(...))`
 * in the runner. A real payment provider works the same way: it recognizes the
 * idempotency key it was given before and returns the original result instead
 * of creating a second charge or refund.
 */
export function mockRefundProvider(
  paths: DataPaths,
  workflowId: string,
  input: WorkflowInput
): SideEffectOutcome<RefundEffectResult> {
  const step = "execute_refund" as const;
  const key = idempotencyKey(workflowId, step);

  const existing = findEffectByKey(paths, key);
  if (existing) {
    // Fail closed: a key that already belongs to the wrong effect type is
    // corrupted persisted state, not a cue to create a second effect under
    // the same key. Silently proceeding here is exactly the kind of "quietly
    // paper over inconsistent state" this module argues against.
    if (existing.type !== "refund") {
      throw new Error(
        `Idempotency key collision: "${key}" already belongs to a "${existing.type}" effect.`
      );
    }
    return { result: existing.result, reused: true };
  }

  const refundId = nextEffectId(paths, "REF", "refund");
  const result: RefundEffectResult = {
    refundId,
    orderId: input.orderId,
    amount: input.amount,
    currency: input.currency,
    status: "processed",
    mock: true,
  };

  appendEffect(paths, {
    key,
    workflowId,
    step,
    type: "refund",
    result,
    createdAt: nowIso(),
  });

  return { result, reused: false };
}

/** Mock confirmation-message provider. Same idempotent-replay shape as the refund provider. */
export function mockConfirmationProvider(
  paths: DataPaths,
  workflowId: string,
  input: WorkflowInput
): SideEffectOutcome<ConfirmationEffectResult> {
  const step = "send_confirmation" as const;
  const key = idempotencyKey(workflowId, step);

  const existing = findEffectByKey(paths, key);
  if (existing) {
    if (existing.type !== "confirmation") {
      throw new Error(
        `Idempotency key collision: "${key}" already belongs to a "${existing.type}" effect.`
      );
    }
    return { result: existing.result, reused: true };
  }

  const confirmationId = nextEffectId(paths, "MSG", "confirmation");
  const result: ConfirmationEffectResult = {
    confirmationId,
    orderId: input.orderId,
    status: "sent",
    mock: true,
  };

  appendEffect(paths, {
    key,
    workflowId,
    step,
    type: "confirmation",
    result,
    createdAt: nowIso(),
  });

  return { result, reused: false };
}
