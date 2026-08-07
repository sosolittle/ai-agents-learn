import type { DataPaths } from "./config.js";
import {
  EffectRecordSchema,
  type EffectRecord,
  type EffectType,
  type WorkflowStep,
} from "./types.js";
import { nextSequentialId, readJsonArray, writeJsonArray } from "./utils.js";

// Persistence for idempotent side effects. This is the mock downstream
// providers' own ledger — it answers "if this step is retried, can it avoid
// repeating the side effect?", which is a different question from "where did
// the workflow get to?" (that's checkpointStore.ts). A workflow step can be
// replayed; the ledger is what stops the business side effect from replaying
// with it.

/** The idempotency key a retried step presents to a mock provider. */
export function idempotencyKey(workflowId: string, step: WorkflowStep): string {
  return `${workflowId}:${step}`;
}

export function loadEffects(paths: DataPaths): EffectRecord[] {
  return readJsonArray(paths.effects, EffectRecordSchema, "Effects");
}

export function findEffectByKey(paths: DataPaths, key: string): EffectRecord | undefined {
  return loadEffects(paths).find((effect) => effect.key === key);
}

/**
 * Append a new effect, enforcing that one idempotency key maps to exactly one
 * effect record. `findEffectByKey` + `appendEffect` is a check-then-write
 * sequence, not an atomic operation, so this is a last-line guard against a
 * bug (or a hand-edited ledger) appending a second record for a key that
 * should have short-circuited to a reuse. It is not a fix for concurrent
 * writers racing each other — see the README's Production notes.
 */
export function appendEffect(paths: DataPaths, effect: EffectRecord): void {
  const effects = loadEffects(paths);
  if (effects.some((existing) => existing.key === effect.key)) {
    throw new Error(
      `Refusing to append a second effect for idempotency key "${effect.key}". ` +
        "One key must map to exactly one effect record."
    );
  }
  effects.push(effect);
  writeJsonArray(paths.effects, effects);
}

export function countEffectsByType(paths: DataPaths, type: EffectType): number {
  return loadEffects(paths).filter((effect) => effect.type === type).length;
}

export function loadEffectsForWorkflow(paths: DataPaths, workflowId: string): EffectRecord[] {
  return loadEffects(paths).filter((effect) => effect.workflowId === workflowId);
}

export function countEffectsForWorkflowByType(
  paths: DataPaths,
  workflowId: string,
  type: EffectType
): number {
  return loadEffectsForWorkflow(paths, workflowId).filter((effect) => effect.type === type).length;
}

/** Next deterministic result ID (e.g. "REF-001", "MSG-001") for an effect type. */
export function nextEffectId(paths: DataPaths, prefix: string, type: EffectType): string {
  const ids = loadEffects(paths)
    .filter((effect) => effect.type === type)
    .map((effect) =>
      effect.type === "refund" ? effect.result.refundId : effect.result.confirmationId
    );
  return nextSequentialId(prefix, ids);
}
