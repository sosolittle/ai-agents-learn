import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { findWorkflow, loadWorkflows } from "../checkpointStore.js";
import type { DataPaths } from "../config.js";
import { countEffectsByType, findEffectByKey, idempotencyKey, loadEffects } from "../effectStore.js";
import { loadEventsForWorkflow } from "../eventLog.js";
import { mockConfirmationProvider, mockRefundProvider, validateApproval } from "../steps.js";
import type { WorkflowInput } from "../types.js";
import {
  createWorkflow,
  resumeWorkflow,
  runWorkflow,
  SimulatedCrashError,
} from "../workflowRunner.js";

// These tests exercise the workflow with NO model calls and NO OpenAI key.
// Every test gets its own temporary data directory so the committed demo
// files under ./data are never touched.

function tempPaths(): DataPaths {
  const dir = mkdtempSync(path.join(tmpdir(), "durable-execution-test-"));
  return {
    workflows: path.join(dir, "workflows.json"),
    effects: path.join(dir, "effects.json"),
    events: path.join(dir, "events.json"),
  };
}

function approvedAction(
  overrides: {
    status?: string;
    approvalId?: string;
    orderId?: string;
    amount?: number;
    currency?: string;
    reason?: string;
  } = {}
) {
  return {
    approvalId: overrides.approvalId ?? "APR-001",
    status: overrides.status ?? "approved",
    toolName: "refundOrder",
    arguments: {
      orderId: overrides.orderId ?? "ORD-001",
      amount: overrides.amount ?? 49,
      currency: overrides.currency ?? "EUR",
      reason: overrides.reason ?? "Partial refund approved after review",
    },
  };
}

function validInput(overrides: Partial<WorkflowInput> = {}): WorkflowInput {
  return {
    approvalId: "APR-001",
    approvalStatus: "approved",
    toolName: "refundOrder",
    orderId: "ORD-001",
    amount: 49,
    currency: "EUR",
    reason: "Partial refund approved after review",
    ...overrides,
  };
}

/** Run createWorkflow + runWorkflow with the crash injected at execute_refund. */
function createAndCrash(paths: DataPaths, action = approvedAction()) {
  const workflow = createWorkflow(paths, action);
  let crashed = false;
  try {
    runWorkflow(paths, workflow.id, { crashAfterSideEffectStep: "execute_refund" });
  } catch (error) {
    if (!(error instanceof SimulatedCrashError)) throw error;
    crashed = true;
  }
  assert.ok(crashed, "expected a SimulatedCrashError during execute_refund");
  return workflow.id;
}

// ── tiny test runner ─────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`      ${(error as Error).message.split("\n")[0]}`);
  }
}

console.log("\nDurable Execution — tests\n");

// 1: approved input validates and the workflow completes.
test("approved input validates and the workflow completes", () => {
  const paths = tempPaths();
  const workflow = createWorkflow(paths, approvedAction());
  const { workflow: finished } = runWorkflow(paths, workflow.id);
  assert.equal(finished.status, "completed");
  assert.deepEqual(finished.completedSteps, [
    "validate_approval",
    "execute_refund",
    "send_confirmation",
  ]);
});

// 2: a pending approval cannot start.
test("a pending approval cannot start", () => {
  const paths = tempPaths();
  const workflow = createWorkflow(paths, approvedAction({ status: "pending" }));
  assert.throws(() => runWorkflow(paths, workflow.id), /approvalStatus must be "approved"/);
  const record = findWorkflow(paths, workflow.id);
  assert.equal(record?.status, "failed");
  assert.equal(countEffectsByType(paths, "refund"), 0);
  assert.equal(countEffectsByType(paths, "confirmation"), 0);
});

// 3: a rejected approval cannot start.
test("a rejected approval cannot start", () => {
  const paths = tempPaths();
  const workflow = createWorkflow(paths, approvedAction({ status: "rejected" }));
  assert.throws(() => runWorkflow(paths, workflow.id), /approvalStatus must be "approved"/);
  assert.equal(findWorkflow(paths, workflow.id)?.status, "failed");
});

// 4: the first pure step checkpoints successfully.
test("validate_approval checkpoints before execute_refund crashes", () => {
  const paths = tempPaths();
  const id = createAndCrash(paths);
  const record = findWorkflow(paths, id);
  assert.ok(record?.completedSteps.includes("validate_approval"));
});

// 5: crash occurs after the refund side effect but before the checkpoint.
// This is the central demonstration of the whole module.
test("crash lands after the refund side effect but before the checkpoint", () => {
  const paths = tempPaths();
  const id = createAndCrash(paths);

  const effect = findEffectByKey(paths, idempotencyKey(id, "execute_refund"));
  assert.ok(effect, "the refund effect must already exist");

  const record = findWorkflow(paths, id);
  assert.ok(!record?.completedSteps.includes("execute_refund"));
  assert.notEqual(record?.status, "completed");
  assert.equal(record?.status, "running");
});

// 6: resume retries the incomplete step, not the whole workflow.
test("resume retries the incomplete step, not validate_approval again", () => {
  const paths = tempPaths();
  const id = createAndCrash(paths);
  resumeWorkflow(paths, id);

  const events = loadEventsForWorkflow(paths, id);
  const resumedIndex = events.findIndex((e) => e.event === "WORKFLOW_RESUMED");
  const nextStepStarted = events.slice(resumedIndex + 1).find((e) => e.event === "STEP_STARTED");
  assert.equal(nextStepStarted?.step, "execute_refund");
});

// 7: the repeated refund reuses the existing side effect (no second refund).
test("repeated refund reuses the existing side effect", () => {
  const paths = tempPaths();
  const id = createAndCrash(paths);
  assert.equal(countEffectsByType(paths, "refund"), 1);
  resumeWorkflow(paths, id);
  assert.equal(countEffectsByType(paths, "refund"), 1);
});

// 8: the recovered refund uses the same refund ID as before the crash.
test("the recovered refund uses the same refund ID", () => {
  const paths = tempPaths();
  const id = createAndCrash(paths);
  const before = findEffectByKey(paths, idempotencyKey(id, "execute_refund"));
  const refundIdBefore = before?.type === "refund" ? before.result.refundId : undefined;
  assert.equal(refundIdBefore, "REF-001");

  const { workflow } = resumeWorkflow(paths, id);
  assert.equal(workflow.context.refundId, "REF-001");
});

// 9: SIDE_EFFECT_REUSED is audited on resume.
test("SIDE_EFFECT_REUSED is audited for execute_refund on resume", () => {
  const paths = tempPaths();
  const id = createAndCrash(paths);
  resumeWorkflow(paths, id);

  const events = loadEventsForWorkflow(paths, id);
  const reused = events.find((e) => e.event === "SIDE_EFFECT_REUSED" && e.step === "execute_refund");
  assert.ok(reused);
});

// 10: send_confirmation executes exactly one local effect on a normal run.
test("send_confirmation executes exactly one local effect", () => {
  const paths = tempPaths();
  const workflow = createWorkflow(paths, approvedAction());
  runWorkflow(paths, workflow.id);
  assert.equal(countEffectsByType(paths, "confirmation"), 1);
});

// 11: resuming a completed workflow is a no-op.
test("resuming a completed workflow is a no-op", () => {
  const paths = tempPaths();
  const workflow = createWorkflow(paths, approvedAction());
  runWorkflow(paths, workflow.id);

  const refundsBefore = countEffectsByType(paths, "refund");
  const confirmationsBefore = countEffectsByType(paths, "confirmation");

  const { workflow: again, noop } = resumeWorkflow(paths, workflow.id);
  assert.equal(noop, true);
  assert.equal(again.status, "completed");
  assert.equal(countEffectsByType(paths, "refund"), refundsBefore);
  assert.equal(countEffectsByType(paths, "confirmation"), confirmationsBefore);
});

// 12: idempotency keys are workflow-specific.
test("idempotency keys are workflow-specific", () => {
  const paths = tempPaths();
  const wf1 = createWorkflow(paths, approvedAction());
  runWorkflow(paths, wf1.id);
  const wf2 = createWorkflow(paths, approvedAction());
  runWorkflow(paths, wf2.id);

  const effect1 = findEffectByKey(paths, idempotencyKey(wf1.id, "execute_refund"));
  const effect2 = findEffectByKey(paths, idempotencyKey(wf2.id, "execute_refund"));
  assert.ok(effect1 && effect2);
  assert.notEqual(effect1.key, effect2.key);
  const id1 = effect1.type === "refund" ? effect1.result.refundId : undefined;
  const id2 = effect2.type === "refund" ? effect2.result.refundId : undefined;
  assert.notEqual(id1, id2);
  assert.equal(countEffectsByType(paths, "refund"), 2);
});

// 13: calling the mock refund provider twice with the same key returns the same result.
test("the mock refund provider returns the same result for a repeated key", () => {
  const paths = tempPaths();
  const input = validInput();
  const first = mockRefundProvider(paths, "WF-001", input);
  const second = mockRefundProvider(paths, "WF-001", input);
  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(first.result.refundId, second.result.refundId);
  assert.equal(countEffectsByType(paths, "refund"), 1);
});

// 14: malformed workflow JSON fails clearly instead of silently resetting.
test("malformed workflow JSON produces a clear error", () => {
  const paths = tempPaths();
  writeFileSync(paths.workflows, "{ this is not valid json", "utf8");
  assert.throws(() => loadWorkflows(paths), /malformed JSON/);
});

// 15: malformed effects JSON fails clearly instead of silently resetting.
test("malformed effects JSON produces a clear error", () => {
  const paths = tempPaths();
  writeFileSync(paths.effects, "{ not json", "utf8");
  assert.throws(() => loadEffects(paths), /malformed JSON/);
});

// 16: an invalid persisted workflow schema fails validation.
test("an invalid persisted workflow schema fails validation", () => {
  const paths = tempPaths();
  writeFileSync(paths.workflows, JSON.stringify([{ status: "banana" }]), "utf8");
  assert.throws(() => loadWorkflows(paths), /invalid shape/);
});

// 17: an unknown workflow ID gives an actionable error.
test("an unknown workflow ID gives an actionable error", () => {
  const paths = tempPaths();
  assert.throws(() => resumeWorkflow(paths, "WF-999"), /No workflow found with id "WF-999"/);
});

// 18: failed validation creates no side effects.
test("failed validation creates no side effects", () => {
  const paths = tempPaths();
  const workflow = createWorkflow(paths, approvedAction({ status: "pending" }));
  assert.throws(() => runWorkflow(paths, workflow.id));
  assert.equal(countEffectsByType(paths, "refund"), 0);
  assert.equal(countEffectsByType(paths, "confirmation"), 0);
});

// 19: a completed workflow's context contains the expected IDs.
test("a completed workflow's context contains the expected IDs", () => {
  const paths = tempPaths();
  const workflow = createWorkflow(paths, approvedAction());
  const { workflow: finished } = runWorkflow(paths, workflow.id);
  assert.equal(finished.context.refundId, "REF-001");
  assert.equal(finished.context.confirmationId, "MSG-001");
});

// 20: event ordering is correct across the crash/resume lifecycle.
test("event ordering is correct across crash and resume", () => {
  const paths = tempPaths();
  const id = createAndCrash(paths);
  resumeWorkflow(paths, id);

  const events = loadEventsForWorkflow(paths, id).map((e) => e.event);
  assert.deepEqual(events, [
    "WORKFLOW_CREATED",
    "WORKFLOW_STARTED",
    "STEP_STARTED",
    "STEP_COMPLETED",
    "STEP_STARTED",
    "SIDE_EFFECT_EXECUTED",
    "WORKFLOW_RESUMED",
    "STEP_STARTED",
    "SIDE_EFFECT_REUSED",
    "STEP_COMPLETED",
    "STEP_STARTED",
    "SIDE_EFFECT_EXECUTED",
    "STEP_COMPLETED",
    "WORKFLOW_COMPLETED",
  ]);
});

// ── additional robustness tests ─────────────────────────────────────────────

// 21: amount <= 0 is rejected by validate_approval.
test("a non-positive amount fails validate_approval", () => {
  assert.throws(() => validateApproval(validInput({ amount: 0 })), /amount must be greater than 0/);
  assert.throws(() => validateApproval(validInput({ amount: -10 })), /amount must be greater than 0/);
});

// 22: an unsupported currency is rejected by validate_approval.
test("an unsupported currency fails validate_approval", () => {
  assert.throws(() => validateApproval(validInput({ currency: "USD" })), /currency must be "EUR"/);
});

// 23: a malformed order ID is rejected by validate_approval.
test("a malformed order ID fails validate_approval", () => {
  assert.throws(() => validateApproval(validInput({ orderId: "not-an-order" })), /orderId must look like/);
});

// 24: a malformed approval ID is rejected by validate_approval.
test("a malformed approval ID fails validate_approval", () => {
  assert.throws(
    () => validateApproval(validInput({ approvalId: "not-an-approval" })),
    /approvalId must look like/
  );
});

// 25: an empty reason is rejected by validate_approval.
test("an empty reason fails validate_approval", () => {
  assert.throws(() => validateApproval(validInput({ reason: "" })), /reason must be non-empty/);
});

// 26: the confirmation provider is idempotent too, independent of the refund provider.
test("the mock confirmation provider is idempotent", () => {
  const paths = tempPaths();
  const input = validInput();
  const first = mockConfirmationProvider(paths, "WF-001", input);
  const second = mockConfirmationProvider(paths, "WF-001", input);
  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(first.result.confirmationId, second.result.confirmationId);
  assert.equal(countEffectsByType(paths, "confirmation"), 1);
});

// 27: missing persistence files are treated as empty, not an error.
test("missing persistence files are treated as empty", () => {
  const paths = tempPaths();
  assert.deepEqual(loadWorkflows(paths), []);
  assert.deepEqual(loadEffects(paths), []);
  assert.deepEqual(loadEventsForWorkflow(paths, "WF-001"), []);
});

// 28: empty persistence files are treated as empty, not an error.
test("empty persistence files are treated as empty", () => {
  const paths = tempPaths();
  writeFileSync(paths.workflows, "", "utf8");
  assert.deepEqual(loadWorkflows(paths), []);
});

// 29: a second resume call after completion still does not duplicate effects.
test("resuming twice after completion never duplicates effects", () => {
  const paths = tempPaths();
  const id = createAndCrash(paths);
  resumeWorkflow(paths, id);
  resumeWorkflow(paths, id);
  assert.equal(countEffectsByType(paths, "refund"), 1);
  assert.equal(countEffectsByType(paths, "confirmation"), 1);
});

// ── summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
