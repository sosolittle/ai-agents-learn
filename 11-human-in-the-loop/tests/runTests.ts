import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  approveApproval,
  editApproval,
  handleProposal,
  rejectApproval,
} from "../approvalService.js";
import { loadApprovals, loadExecutions } from "../approvalStore.js";
import { loadAudit } from "../auditLog.js";
import type { DataPaths } from "../config.js";
import { executeAction } from "../executor.js";
import { evaluatePolicy } from "../policy.js";
import type { ApprovalRecord } from "../types.js";

// These tests exercise the workflow with NO model calls and NO OpenAI key.
// Every test gets its own temporary data directory so the committed demo files
// under ./data are never touched.

function tempPaths(): DataPaths {
  const dir = mkdtempSync(path.join(tmpdir(), "hitl-test-"));
  return {
    approvals: path.join(dir, "approvals.json"),
    audit: path.join(dir, "audit-log.json"),
    executions: path.join(dir, "executions.json"),
  };
}

const REFUND_REQUEST = "Refund €79.00 for order ORD-001 because the package arrived damaged.";

function refundProposal(amount = 79) {
  return {
    toolName: "refundOrder",
    arguments: {
      orderId: "ORD-001",
      amount,
      currency: "EUR",
      reason: "Package arrived damaged",
    },
    reason: "Customer reports the package arrived damaged.",
  };
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

console.log("\nHuman-in-the-Loop — tests\n");

// 1–4: deterministic policy decisions.
test("getOrderStatus receives auto_execute", () => {
  assert.equal(evaluatePolicy("getOrderStatus").decision, "auto_execute");
});
test("refundOrder receives require_approval", () => {
  assert.equal(evaluatePolicy("refundOrder").decision, "require_approval");
});
test("cancelSubscription receives require_approval", () => {
  assert.equal(evaluatePolicy("cancelSubscription").decision, "require_approval");
});
test("deleteProductionUsers receives deny", () => {
  assert.equal(evaluatePolicy("deleteProductionUsers").decision, "deny");
});

// 5: a refund proposal creates a pending approval and does not execute.
test("refund proposal creates a pending approval and does not execute", () => {
  const paths = tempPaths();
  const outcome = handleProposal(paths, REFUND_REQUEST, refundProposal());
  assert.equal(outcome.kind, "pending");
  const approvals = loadApprovals(paths);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].status, "pending");
  assert.equal(loadExecutions(paths).length, 0);
});

// 6: approving a valid pending refund executes it once.
test("approving a valid pending refund executes it once", () => {
  const paths = tempPaths();
  const { record } = handleProposal(paths, REFUND_REQUEST, refundProposal()) as {
    record: ApprovalRecord;
  };
  const result = approveApproval(paths, record.id);
  assert.equal(result.blocked, false);
  assert.equal(result.record.status, "executed");
  const executions = loadExecutions(paths);
  assert.equal(executions.length, 1);
  assert.equal(executions[0].result.status, "processed");
});

// 7: approving the same record again does not execute it twice.
test("approving the same record again does not execute twice", () => {
  const paths = tempPaths();
  const { record } = handleProposal(paths, REFUND_REQUEST, refundProposal()) as {
    record: ApprovalRecord;
  };
  approveApproval(paths, record.id);
  const second = approveApproval(paths, record.id);
  assert.equal(second.blocked, true);
  assert.equal(loadExecutions(paths).length, 1);
  assert.equal(loadApprovals(paths)[0].status, "executed");
});

// 8: rejecting a pending action prevents execution.
test("rejecting a pending action prevents execution", () => {
  const paths = tempPaths();
  const { record } = handleProposal(paths, REFUND_REQUEST, refundProposal()) as {
    record: ApprovalRecord;
  };
  const rejected = rejectApproval(paths, record.id, "Customer is not eligible");
  assert.equal(rejected.status, "rejected");
  assert.equal(loadExecutions(paths).length, 0);
  assert.throws(() => approveApproval(paths, record.id), /not "pending"/);
});

// 9: editing a pending refund to €49 succeeds.
test("editing a pending refund to €49 succeeds", () => {
  const paths = tempPaths();
  const { record } = handleProposal(paths, REFUND_REQUEST, refundProposal()) as {
    record: ApprovalRecord;
  };
  const { after } = editApproval(paths, record.id, {
    amount: "49",
    reason: "Partial refund approved after review",
  });
  assert.equal(after.amount, 49);
  assert.equal(loadApprovals(paths)[0].status, "pending");
  assert.equal(loadApprovals(paths)[0].proposedAction.arguments.amount, 49);
});

// 10: editing a refund to a negative amount fails validation.
test("editing a refund to a negative amount fails validation", () => {
  const paths = tempPaths();
  const { record } = handleProposal(paths, REFUND_REQUEST, refundProposal()) as {
    record: ApprovalRecord;
  };
  assert.throws(() => editApproval(paths, record.id, { amount: "-10" }));
  // The record is unchanged and still valid.
  assert.equal(loadApprovals(paths)[0].proposedAction.arguments.amount, 79);
});

// 11: editing protected approval fields is not allowed.
test("editing protected approval fields is not allowed", () => {
  const paths = tempPaths();
  const { record } = handleProposal(paths, REFUND_REQUEST, refundProposal()) as {
    record: ApprovalRecord;
  };
  assert.throws(
    () => editApproval(paths, record.id, { status: "executed" }),
    /protected field/
  );
  assert.throws(
    () => editApproval(paths, record.id, { id: "APR-999" }),
    /protected field/
  );
});

// 12: a denied action never reaches a tool executor.
test("a denied action never reaches a tool executor", () => {
  const paths = tempPaths();
  const outcome = handleProposal(paths, "Delete all production users.", {
    toolName: "deleteProductionUsers",
    arguments: {},
    reason: "User asked to delete all production users.",
  });
  assert.equal(outcome.kind, "denied");
  assert.equal(loadApprovals(paths).length, 0);
  assert.equal(loadExecutions(paths).length, 0);

  // Defense in depth: even a direct executor call is refused.
  const forgedRecord: ApprovalRecord = {
    id: "APR-999",
    originalRequest: "forged",
    proposedAction: {
      toolName: "deleteProductionUsers",
      arguments: {},
      reason: "forged",
    },
    status: "pending",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  assert.throws(() => executeAction(paths, forgedRecord), /denied by policy/);
});

// 13: approval data survives store reloading.
test("approval data survives store reloading", () => {
  const paths = tempPaths();
  const { record } = handleProposal(paths, REFUND_REQUEST, refundProposal()) as {
    record: ApprovalRecord;
  };
  // Fresh read from disk (no in-memory state carried over).
  const reloaded = loadApprovals(paths).find((r) => r.id === record.id);
  assert.ok(reloaded);
  assert.equal(reloaded?.originalRequest, REFUND_REQUEST);
  assert.equal(reloaded?.proposedAction.arguments.amount, 79);
});

// 14: expected audit events are written in the correct lifecycle.
test("expected audit events are written in the correct lifecycle", () => {
  const paths = tempPaths();
  const { record } = handleProposal(paths, REFUND_REQUEST, refundProposal()) as {
    record: ApprovalRecord;
  };
  editApproval(paths, record.id, { amount: "49" });
  approveApproval(paths, record.id);
  approveApproval(paths, record.id); // duplicate → blocked

  const events = loadAudit(paths).map((e) => e.event);
  assert.deepEqual(events, [
    "ACTION_PROPOSED",
    "POLICY_EVALUATED",
    "APPROVAL_REQUESTED",
    "ACTION_EDITED",
    "ACTION_APPROVED",
    "ACTION_EXECUTED",
    "DUPLICATE_EXECUTION_BLOCKED",
  ]);
});

// 15: malformed persisted JSON produces a clear error, not a silent reset.
test("malformed persisted JSON produces a clear error", () => {
  const paths = tempPaths();
  writeFileSync(paths.approvals, "{ this is not valid json", "utf8");
  assert.throws(() => loadApprovals(paths), /malformed JSON/);
});

// ── summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
