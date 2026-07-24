// ============================================================
//  第十一章测试：验证控制边界，而不是验证模型措辞
//
//  测试重点：
//  1. 三种 policy 决策是否稳定
//  2. pending / approved / executed / rejected 状态迁移是否正确
//  3. 未审批、已拒绝和 deny 动作是否无法绕过 executor
//  4. 重复审批与崩溃恢复是否会复用已有 execution
//
//  测试不调用模型：模型输出可能变化，但安全不变量必须由确定性测试保证。
// ============================================================

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
import {
  loadApprovals,
  loadExecutions,
  upsertApproval,
} from "../approvalStore.js";
import { loadAudit } from "../auditLog.js";
import type { DataPaths } from "../config.js";
import { executeAction } from "../executor.js";
import { evaluatePolicy } from "../policy.js";
import { ActionProposalSchema, type ApprovalRecord } from "../types.js";

// These tests exercise the workflow with NO model calls and NO OpenAI key.
// Every test gets its own temporary data directory so the committed demo files
// under ./data are never touched.

function tempPaths(): DataPaths {
  // 每个测试创建独立目录，既避免测试之间相互污染，也不会改动 data/ 下的
  // 演示审批单。DataPaths 注入是实现这种隔离的关键。
  const dir = mkdtempSync(path.join(tmpdir(), "hitl-test-"));
  return {
    approvals: path.join(dir, "approvals.json"),
    audit: path.join(dir, "audit-log.json"),
    executions: path.join(dir, "executions.json"),
  };
}

const REFUND_REQUEST = "Refund €79.00 for order ORD-001 because the package arrived damaged.";

function refundProposal(amount = 79) {
  // 直接构造合法提案，跳过模型，只测试模型之后的控制链。
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
  // 轻量 runner 让章节保持零测试框架依赖；失败会统一累计并设置退出码。
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
// 第一组先锁定工具与策略的映射；一旦误把退款改成 auto_execute，测试立即失败。
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
// “创建审批单”和“没有执行记录”必须同时成立，才能证明流程真的暂停了。
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
// 审计测试不仅检查事件是否存在，还检查顺序，确保因果链可以被可靠重放。
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

// ── control-boundary tests ───────────────────────────────────────────────────
// 下面不是普通 happy path，而是主动尝试绕过审批边界。
// 安全代码既要证明“合法动作能执行”，也要证明“非法路径执行不了”。

// 16: a pending refund cannot bypass human approval through the executor.
test("pending refund cannot bypass human approval through the executor", () => {
  const paths = tempPaths();
  const { record } = handleProposal(paths, REFUND_REQUEST, refundProposal()) as {
    record: ApprovalRecord;
  };
  assert.equal(record.status, "pending");
  assert.throws(() => executeAction(paths, record), /human approval|required.*approved/i);
  assert.equal(loadExecutions(paths).length, 0);
});

// 17: a rejected refund cannot execute directly through the executor.
test("rejected refund cannot execute directly through the executor", () => {
  const paths = tempPaths();
  const { record } = handleProposal(paths, REFUND_REQUEST, refundProposal()) as {
    record: ApprovalRecord;
  };
  const rejected = rejectApproval(paths, record.id, "Customer is not eligible");
  assert.equal(rejected.status, "rejected");
  assert.throws(() => executeAction(paths, rejected), /human approval|approved/i);
  assert.equal(loadExecutions(paths).length, 0);
});

// 18: the executor accepts an approved record (the other side of boundary 2).
test("executor accepts an approved refund record", () => {
  const paths = tempPaths();
  const { record } = handleProposal(paths, REFUND_REQUEST, refundProposal()) as {
    record: ApprovalRecord;
  };
  const approved: ApprovalRecord = { ...record, status: "approved" };
  upsertApproval(paths, approved);
  const outcome = executeAction(paths, approved);
  assert.equal(outcome.recovered, false);
  assert.equal(outcome.result.status, "processed");
  assert.equal(loadExecutions(paths).length, 1);
});

// 19: a model-supplied permission field is rejected by the proposal schema.
test("proposal rejects model-supplied permission fields", () => {
  assert.throws(() =>
    ActionProposalSchema.parse({ ...refundProposal(), requiresApproval: false })
  );
  assert.throws(() =>
    ActionProposalSchema.parse({ ...refundProposal(), isAuthorized: true })
  );
});

// 20: an existing execution is reused rather than duplicated (crash recovery).
test("an existing execution is reused rather than duplicated", () => {
  const paths = tempPaths();
  const { record } = handleProposal(paths, REFUND_REQUEST, refundProposal()) as {
    record: ApprovalRecord;
  };
  // Simulate a crash: the record is approved and the tool ran (an execution is
  // saved), but the status was never flipped to "executed".
  // 这里手动制造 approved + execution 已存在的中间态，模拟真实崩溃窗口。
  const approved: ApprovalRecord = { ...record, status: "approved" };
  upsertApproval(paths, approved);
  const firstRun = executeAction(paths, approved);
  assert.equal(firstRun.recovered, false);

  // Retrying approval must NOT call the tool again.
  const retry = approveApproval(paths, record.id);
  assert.equal(retry.blocked, false);
  assert.equal(retry.execution?.recovered, true);
  assert.equal(retry.execution?.executionId, firstRun.executionId);
  assert.equal(retry.record.status, "executed");
  assert.equal(loadExecutions(paths).length, 1);
});

// 21: a failed auto-execution is not left marked executed.
test("failed auto-execution is not left marked executed", () => {
  const paths = tempPaths();
  // getOrderStatus auto-executes, but ORD-999 does not exist, so the tool throws.
  assert.throws(
    () =>
      handleProposal(paths, "Check the status of order ORD-999.", {
        toolName: "getOrderStatus",
        arguments: { orderId: "ORD-999" },
        reason: "Look up the order status.",
      }),
    /Unknown order/
  );
  // A record may exist as "approved", but never as "executed", and no execution
  // record was written.
  assert.ok(loadApprovals(paths).every((r) => r.status !== "executed"));
  assert.equal(loadExecutions(paths).length, 0);
});

// 22: a policy that no longer says require_approval blocks the approval path.
test("policy mismatch blocks approval", () => {
  const paths = tempPaths();
  // A stored pending approval whose tool is classified auto_execute, not
  // require_approval — a stale workflow the current policy no longer matches.
  const now = new Date().toISOString();
  const stale: ApprovalRecord = {
    id: "APR-001",
    originalRequest: "Check the status of order ORD-001.",
    proposedAction: {
      toolName: "getOrderStatus",
      arguments: { orderId: "ORD-001" },
      reason: "Look up the order status.",
    },
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };
  upsertApproval(paths, stale);
  assert.throws(
    () => approveApproval(paths, "APR-001"),
    /no longer classified as require_approval/
  );
  assert.equal(loadExecutions(paths).length, 0);
});

// 23: a denied action writes ACTION_DENIED and creates no records.
test("denied action writes ACTION_DENIED and creates no records", () => {
  const paths = tempPaths();
  handleProposal(paths, "Delete all production users.", {
    toolName: "deleteProductionUsers",
    arguments: {},
    reason: "User asked to delete all production users.",
  });
  const events = loadAudit(paths).map((e) => e.event);
  assert.deepEqual(events, ["ACTION_PROPOSED", "POLICY_EVALUATED", "ACTION_DENIED"]);
  assert.equal(loadApprovals(paths).length, 0);
  assert.equal(loadExecutions(paths).length, 0);
});

// ── summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed\n`);
// 让 npm test 在任一断言失败时返回非零状态，便于自动化环境识别失败。
if (failed > 0) process.exit(1);
