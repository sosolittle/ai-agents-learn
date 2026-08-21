// ============================================================
//  第十一章测试：验证控制边界，而不是验证模型措辞
//
//  🏠 生活化比喻：给审批处做的「防抢演习」。不是演给参观者看的
//  规定动作（happy path 也有，但只是开胃菜），而是雇红队来抢银行：
//  伪造签字的单、重复兑现的支票、硬闯出纳窗口、半夜涂改账本……
//  23 个测试里一多半在扮演劫匪，每一个都必须被当场按住、
//  留下清晰报错——放跑任何一个都是真的丢钱。
//
//  测试重点：
//  1. 三种 policy 决策是否稳定
//  2. pending / approved / executed / rejected 状态迁移是否正确
//  3. 未审批、已拒绝和 deny 动作是否无法绕过 executor
//  4. 重复审批与崩溃恢复是否会复用已有 execution
//
//  测试不调用模型：模型输出可能变化，但安全不变量必须由确定性测试保证。
//
//  本文件的两个核心设计：
//  1. 零框架：一个 20 行的迷你 test() 函数替代 jest/vitest，
//     跑法就是 `tsx tests/runTests.ts`，输出 ✓/✗ 和统计。
//  2. 临时目录隔离：每个测试用 mkdtempSync 建独立目录，
//     data/ 下的演示数据永不被测试碰坏。
//
//  测试的哲学（值得先于代码阅读）：
//  安全系统要测的不是"正常路径能走通"，
//  而是"恶意/错误路径走不通"。本文件 23 个测试里，
//  一半以上是在主动攻击系统：
//  伪造审批单直接调 executor、重复批准、塞权限字段、
//  手改坏 JSON……每一个都应该被拦下并留下清晰报错。
// ============================================================

import assert from "node:assert/strict";
// Node 内置断言库；/strict 后缀启用严格模式
// （assert.equal 用 === 语义、多播更严的检查）。
// 不用第三方断言，模块保持零测试框架依赖。
import { mkdtempSync, writeFileSync } from "node:fs";
// mkdtempSync：创建带随机后缀的临时目录（每次调用目录名都不同）
// writeFileSync：直接写文件——测试要手工"种"坏数据时用
import { tmpdir } from "node:os";
// tmpdir()：操作系统临时目录（macOS/Linux 是 /tmp）
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
// upsertApproval 在测试里用来"手工制造"特殊状态的审批单
// （比如把 pending 单偷偷改成 approved——模拟绕过正常流程的调用）
import { loadAudit } from "../auditLog.js";
import type { DataPaths } from "../config.js";
import { executeAction } from "../executor.js";
// executeAction 被 import 来做"绕过 service 的直接攻击"
import { evaluatePolicy } from "../policy.js";
import { ActionProposalSchema, type ApprovalRecord } from "../types.js";

// 这些测试在运行整个工作流时不调用模型、不需要 OpenAI Key。
// 每个测试都有自己独立的临时数据目录，
// 所以 ./data 下提交的演示文件永远不会被碰。

function tempPaths(): DataPaths {
  // 每个测试创建独立目录，既避免测试之间相互污染，也不会改动 data/ 下的
  // 演示审批单。DataPaths 注入是实现这种隔离的关键。
  const dir = mkdtempSync(path.join(tmpdir(), "hitl-test-"));
  // mkdtempSync("模板")：在模板路径末尾追加 6 个随机字符建目录，
  // 例如 /tmp/hitl-test-xK3pQ9——天然互不冲突，
  // 并行跑多少次测试都不会撞车。
  return {
    approvals: path.join(dir, "approvals.json"),
    audit: path.join(dir, "audit-log.json"),
    executions: path.join(dir, "executions.json"),
  };
}

const REFUND_REQUEST = "Refund €79.00 for order ORD-001 because the package arrived damaged.";
// 和 index.ts 里同一个演示请求。测试数据刻意对齐演示故事线，
// 出错时可以从测试直接对照 README 的示例输出。

function refundProposal(amount = 79) {
  // 直接构造合法提案，跳过模型，只测试模型之后的控制链。
  // 默认参数 79：不传就是"全款"，传 49 就是"部分退款"。
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
  // 注意返回类型"恰好是" ActionProposal 的形状但没标类型——
  // 故意的：handleProposal 的参数是 unknown（第一道边界会 parse），
  // 测试正好同时覆盖"从外部世界进来的数据"这条路径。
}

// ── 迷你测试运行器 ─────────────────────────────────────────────────────────
// 20 行实现一个测试框架的核心功能：登记、执行、计数、报告。
// 学习项目里"少一个依赖"往往比"多一个功能"更值。

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
    // .split("\n")[0]：只显示错误第一行。
    // Zod 错误动辄几十行，全打出来会淹没 ✓/✗ 清单；
    // 需要详情时再单独跑那个场景。
    // 注意：失败不抛出、不中断——让全部测试跑完再统一报告，
    // 一次运行能看到所有失败，而不是修一个才看见下一个。
  }
}

console.log("\nHuman-in-the-Loop — tests\n");

// ── 第一组：策略映射（测试 1–4）───────────────────────────────────────────
// 确定性的 policy 决策。
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
// 四个测试就是策略表的"快照"。policy.ts 的 Record 类型
// 已保证穷尽，这四个断言进一步保证"值没被改错"——
// 类型系统管"都有"，测试管"都对"。

// ── 第二组：提案 → 审批单生命周期（测试 5–14）─────────────────────────────

// 5: 退款提案创建一张 pending 单，且不执行。
// "创建审批单"和"没有执行记录"必须同时成立，才能证明流程真的暂停了。
test("refund proposal creates a pending approval and does not execute", () => {
  const paths = tempPaths();
  const outcome = handleProposal(paths, REFUND_REQUEST, refundProposal());
  assert.equal(outcome.kind, "pending");
  // 判别字段先验证：这一单确实走了 require_approval 路径。
  const approvals = loadApprovals(paths);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].status, "pending");
  assert.equal(loadExecutions(paths).length, 0);
  // "暂停"的两个证据：单是 pending + 执行记录为零。
  // 只看单不看执行是不够的——执行了 0 次才是暂停的本义。
});

// 6: 批准一张合法的 pending 退款，会恰好执行一次。
test("approving a valid pending refund executes it once", () => {
  const paths = tempPaths();
  const { record } = handleProposal(paths, REFUND_REQUEST, refundProposal()) as {
    record: ApprovalRecord;
  };
  // as 断言收窄联合类型：测试已知走 pending 路径，
  // 直接把 outcome 当 pending 分支用。
  // （生产代码用 if 收窄更严谨；测试里这样写是常见的取舍。）
  const result = approveApproval(paths, record.id);
  assert.equal(result.blocked, false);
  assert.equal(result.record.status, "executed");
  // 批准后状态推进到 executed。
  const executions = loadExecutions(paths);
  assert.equal(executions.length, 1);
  // 恰好一条执行记录。
  assert.equal(executions[0].result.status, "processed");
  // 而且工具结果正常。
});

// 7: 对同一张单再次批准，不会执行两次。
test("approving the same record again does not execute twice", () => {
  const paths = tempPaths();
  const { record } = handleProposal(paths, REFUND_REQUEST, refundProposal()) as {
    record: ApprovalRecord;
  };
  approveApproval(paths, record.id);
  const second = approveApproval(paths, record.id);
  assert.equal(second.blocked, true);
  // 第二次被幂等守卫拦下（blocked）。
  assert.equal(loadExecutions(paths).length, 1);
  // 执行记录仍然只有一条——"没有再调工具"的持久证据。
  assert.equal(loadApprovals(paths)[0].status, "executed");
  // 状态没有被第二次调用弄乱。
});

// 8: 拒绝一张 pending 单会阻止执行。
test("rejecting a pending action prevents execution", () => {
  const paths = tempPaths();
  const { record } = handleProposal(paths, REFUND_REQUEST, refundProposal()) as {
    record: ApprovalRecord;
  };
  const rejected = rejectApproval(paths, record.id, "Customer is not eligible");
  assert.equal(rejected.status, "rejected");
  assert.equal(loadExecutions(paths).length, 0);
  // 拒绝后零执行。
  assert.throws(() => approveApproval(paths, record.id), /not "pending"/);
  // 而且 rejected 是终态：再批准会抛错。
});

// 9: 把 pending 退款编辑成 €49 会成功。
test("editing a pending refund to €49 succeeds", () => {
  const paths = tempPaths();
  const { record } = handleProposal(paths, REFUND_REQUEST, refundProposal()) as {
    record: ApprovalRecord;
  };
  const { after } = editApproval(paths, record.id, {
    amount: "49",
    // 注意值是字符串——CLI 世界的真实形态，
    // 走 service 的 coerceNumber 转换路径。
    reason: "Partial refund approved after review",
  });
  assert.equal(after.amount, 49);
  // 返回的 after 里 amount 已是数字 49。
  assert.equal(loadApprovals(paths)[0].status, "pending");
  // 编辑不改变状态（还是 pending）。
  assert.equal(loadApprovals(paths)[0].proposedAction.arguments.amount, 49);
  // 且新值确实持久化了。
});

// 10: 把退款编辑成负数金额会校验失败。
test("editing a refund to a negative amount fails validation", () => {
  const paths = tempPaths();
  const { record } = handleProposal(paths, REFUND_REQUEST, refundProposal()) as {
    record: ApprovalRecord;
  };
  assert.throws(() => editApproval(paths, record.id, { amount: "-10" }));
  // 负数被 positive() 拒绝。
  // The record is unchanged and still valid.
  assert.equal(loadApprovals(paths)[0].proposedAction.arguments.amount, 79);
  // 关键的后半段：失败的编辑没有留下任何痕迹——
  // "要么全有要么全无"的落盘策略生效。
});

// 11: 不允许编辑受保护的审批字段。
test("editing protected approval fields is not allowed", () => {
  const paths = tempPaths();
  const { record } = handleProposal(paths, REFUND_REQUEST, refundProposal()) as {
    record: ApprovalRecord;
  };
  assert.throws(
    () => editApproval(paths, record.id, { status: "executed" }),
    /protected field/
    // 最凶险的攻击：一句话把单据状态改成 executed。
  );
  assert.throws(
    () => editApproval(paths, record.id, { id: "APR-999" }),
    /protected field/
    // 以及换掉单据身份（让审计对不上号）。
  );
});

// ── 第三组：deny 分支与伪造攻击（测试 12、19）────────────────────────────

// 12: 被禁止的动作永远到不了工具执行器。
test("a denied action never reaches a tool executor", () => {
  const paths = tempPaths();
  const outcome = handleProposal(paths, "Delete all production users.", {
    toolName: "deleteProductionUsers",
    arguments: {},
    reason: "User asked to delete all production users.",
  });
  // 手工构造一个"合法但危险"的提案——
  // 合法指通过 Schema（工具在枚举里、参数形状对），
  // 危险指工具本身是 deny 的。策略表必须拦下它。
  assert.equal(outcome.kind, "denied");
  assert.equal(loadApprovals(paths).length, 0);
  // 不产生审批单……
  assert.equal(loadExecutions(paths).length, 0);
  // ……也不产生执行。

  // Defense in depth: even a direct executor call is refused.
  const forgedRecord: ApprovalRecord = {
    id: "APR-999",
    originalRequest: "forged",
    // 手工伪造一张"看起来合法"的审批单：字段齐全、类型正确。
    // 攻击模型：不通过 service，直接把伪造单塞给 executor。
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
  // executor 的边界 1（deny 永不执行）拦下了这次攻击。
});

// ── 第四组：持久化与审计（测试 13–15）─────────────────────────────────────

// 13: 审批数据能在 store 重新加载后幸存。
test("approval data survives store reloading", () => {
  const paths = tempPaths();
  const { record } = handleProposal(paths, REFUND_REQUEST, refundProposal()) as {
    record: ApprovalRecord;
  };
  // Fresh read from disk (no in-memory state carried over).
  // 模拟"进程重启"：所有数据从 JSON 重新读入，
  // 不复用内存对象。跨进程恢复的前提就是"落盘的能读回来"。
  const reloaded = loadApprovals(paths).find((r) => r.id === record.id);
  assert.ok(reloaded);
  assert.equal(reloaded?.originalRequest, REFUND_REQUEST);
  assert.equal(reloaded?.proposedAction.arguments.amount, 79);
});

// 14: 预期的审计事件按正确的生命周期顺序写入。
// 审计测试不仅检查事件是否存在，还检查顺序，确保因果链可以被可靠重放。
test("expected audit events are written in the correct lifecycle", () => {
  const paths = tempPaths();
  const { record } = handleProposal(paths, REFUND_REQUEST, refundProposal()) as {
    record: ApprovalRecord;
  };
  // 走一遍完整故事：编辑 → 批准 →（重复批准被拦）
  editApproval(paths, record.id, { amount: "49" });
  approveApproval(paths, record.id);
  approveApproval(paths, record.id); // duplicate → blocked

  const events = loadAudit(paths).map((e) => e.event);
  assert.deepEqual(events, [
    "ACTION_PROPOSED",              // 模型提案
    "POLICY_EVALUATED",             // 策略判定
    "APPROVAL_REQUESTED",           // 创建 pending 单
    "ACTION_EDITED",                // 人工编辑 79→49
    "ACTION_APPROVED",              // 人工批准
    "ACTION_EXECUTED",              // 工具执行
    "DUPLICATE_EXECUTION_BLOCKED",  // 重复批准被拦
  ]);
  // deepEqual 比较整个数组（含顺序）——
  // 一条断言同时验证"都发生了"和"按因果顺序发生"。
});

// 15: 损坏的持久化 JSON 产生清晰错误，而不是静默重置。
test("malformed persisted JSON produces a clear error", () => {
  const paths = tempPaths();
  // 手工种一个坏文件（这是真实世界会遇到的：
  // 写盘断电、并发写、误操作 vim 进去改坏……）
  writeFileSync(paths.approvals, "{ this is not valid json", "utf8");
  assert.throws(() => loadApprovals(paths), /malformed JSON/);
  // 期望：抛"malformed JSON"错误。
  // 如果实现改成"坏了就当空数组"，这个测试失败——
  // 静默丢数据是比崩溃严重得多的事故。
});

// ── 第五组：控制边界攻击测试 ───────────────────────────────────────────────
// 下面不是普通 happy path，而是主动尝试绕过审批边界。
// 安全代码既要证明"合法动作能执行"，也要证明"非法路径执行不了"。
//
// 这组测试和上面 12/19 的共同点：它们都在"作弊"——
// 用 API 允许的方式构造出不该出现的局面，
// 然后验证系统仍然守得住。这正是安全测试和功能测试的区别。

// 16: 一张 pending 退款单无法通过 executor 绕过人工审批。
test("pending refund cannot bypass human approval through the executor", () => {
  const paths = tempPaths();
  const { record } = handleProposal(paths, REFUND_REQUEST, refundProposal()) as {
    record: ApprovalRecord;
  };
  assert.equal(record.status, "pending");
  // 攻击：pending 单（还没人批）直接调 executor。
  assert.throws(() => executeAction(paths, record), /human approval|required.*approved/i);
  // 正则末尾的 i 是大小写不敏感标志——
  // 错误消息措辞微调不会让测试变脆。
  assert.equal(loadExecutions(paths).length, 0);
});

// 17: 一张被拒绝的退款单无法直接通过 executor 执行。
test("rejected refund cannot execute directly through the executor", () => {
  const paths = tempPaths();
  const { record } = handleProposal(paths, REFUND_REQUEST, refundProposal()) as {
    record: ApprovalRecord;
  };
  const rejected = rejectApproval(paths, record.id, "Customer is not eligible");
  assert.equal(rejected.status, "rejected");
  // 攻击：拿着 rejected 单硬闯 executor。
  assert.throws(() => executeAction(paths, rejected), /human approval|approved/i);
  assert.equal(loadExecutions(paths).length, 0);
});

// 18: executor 接受一张 approved 记录（边界 2 的另一面）。
test("executor accepts an approved refund record", () => {
  const paths = tempPaths();
  const { record } = handleProposal(paths, REFUND_REQUEST, refundProposal()) as {
    record: ApprovalRecord;
  };
  // 这次"作弊"是为了测正面：手工把单据推进到 approved，
  // 验证 executor 不会矫枉过正（把合法授权也拒了）。
  const approved: ApprovalRecord = { ...record, status: "approved" };
  upsertApproval(paths, approved);
  // 手工 upsert 模拟"授权已完成"的状态
  // （正常路径里这一步由 approveApproval 内部完成）。
  const outcome = executeAction(paths, approved);
  assert.equal(outcome.recovered, false);
  // 全新执行（不是复用）。
  assert.equal(outcome.result.status, "processed");
  assert.equal(loadExecutions(paths).length, 1);
  // 边界测试要测两面：拦得住非法，也放得过合法。
});

// 19: 模型提供的权限字段会被提案 Schema 拒绝。
test("proposal rejects model-supplied permission fields", () => {
  // 攻击模型：模型在输出里夹带"我不需要审批"的字段。
  assert.throws(() =>
    ActionProposalSchema.parse({ ...refundProposal(), requiresApproval: false })
  );
  // requiresApproval: false —— "我自己说了不用审批"
  assert.throws(() =>
    ActionProposalSchema.parse({ ...refundProposal(), isAuthorized: true })
  );
  // isAuthorized: true —— "我已经授权了"
  //
  // 两个字段都被外层 .strict() 拒绝。
  // 这条测试是"capability ≠ permission"在代码层面的最终证明：
  // 无论模型（或攻击者）在 JSON 里写什么权限声明，
  // Schema 的白名单结构让它们连门都进不来。
});

// ── 第六组：恢复与失败路径（测试 20–23）───────────────────────────────────

// 20: 已存在的执行会被复用而不是重复（崩溃恢复）。
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
  // 第一跑：真实执行。

  // Retrying approval must NOT call the tool again.
  const retry = approveApproval(paths, record.id);
  // 重试 approve：此时单据是 approved + execution 已存在。
  assert.equal(retry.blocked, false);
  // 不是 blocked（那表示已 executed 的重复）……
  assert.equal(retry.execution?.recovered, true);
  // ……而是 recovered：找到了既有执行并复用。
  assert.equal(retry.execution?.executionId, firstRun.executionId);
  // 复用的是同一个 executionId。
  assert.equal(retry.record.status, "executed");
  // 状态补齐为 executed（对账完成）。
  assert.equal(loadExecutions(paths).length, 1);
  // 总执行数不变——工具只跑过一次。
});

// 21: 失败的自动执行不会被留在"已执行"状态。
test("failed auto-execution is not left marked executed", () => {
  const paths = tempPaths();
  // getOrderStatus auto-executes, but ORD-999 does not exist, so the tool throws.
  // 场景：auto_execute 的工具在执行时抛错（订单不存在）。
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
  // every()：所有单据都不是 executed——
  // 状态机"成功才标 executed"的真实性验证。
  assert.equal(loadExecutions(paths).length, 0);
  // 失败的执行不留执行记录（工具抛错在 saveExecution 之前）。
});

// 22: 策略不再说 require_approval 时，审批路径被阻断。
test("policy mismatch blocks approval", () => {
  const paths = tempPaths();
  // A stored pending approval whose tool is classified auto_execute, not
  // require_approval — a stale workflow the current policy no longer matches.
  // 场景：一张"陈旧"的 pending 单——它的工具现在是 auto_execute。
  // 正常流程不会造出这种单（auto_execute 不进 pending），
  // 但策略表是会改的：昨天 require_approval 的工具今天改成 auto，
  // 昨天的 pending 单就成了陈旧单。
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
  // 手工种进 store，模拟"策略漂移前的历史数据"。
  assert.throws(
    () => approveApproval(paths, "APR-001"),
    /no longer classified as require_approval/
    // approveApproval 的双重复核之一：审批时重查策略。
  );
  assert.equal(loadExecutions(paths).length, 0);
});

// 23: 被禁止的动作写入 ACTION_DENIED，且不创建任何记录。
test("denied action writes ACTION_DENIED and creates no records", () => {
  const paths = tempPaths();
  handleProposal(paths, "Delete all production users.", {
    toolName: "deleteProductionUsers",
    arguments: {},
    reason: "User asked to delete all production users.",
  });
  const events = loadAudit(paths).map((e) => e.event);
  assert.deepEqual(events, ["ACTION_PROPOSED", "POLICY_EVALUATED", "ACTION_DENIED"]);
  // deny 路径的完整事件链：提案 → 判定 → 拒绝。
  // 被拦下的尝试在审计里可见（未遂事件同样要留痕）。
  assert.equal(loadApprovals(paths).length, 0);
  assert.equal(loadExecutions(paths).length, 0);
});

// ── 汇总 ──────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed\n`);
// 让 npm test 在任一断言失败时返回非零状态，便于自动化环境识别失败。
if (failed > 0) process.exit(1);
// process.exit(1)：这里可以立即退出——
// 输出都是 console.log（同步写 stdout），不存在截断风险
// （对比 index.ts 里优先用 exitCode 的注释）。

// ============================================================
//  本文件小结：23 个测试覆盖的安全不变量
// ============================================================
//
// | 不变量                         | 测试编号 |
// |--------------------------------|----------|
// | 策略表三档划分正确              | 1–4      |
// | require_approval 会真正暂停     | 5        |
// | 批准 → 恰好执行一次             | 6, 7     |
// | 拒绝是终态                     | 8        |
// | 编辑受限且全量复验              | 9–11     |
// | deny 永不可达（含伪造攻击）     | 12       |
// | 数据可跨进程恢复                | 13       |
// | 审计事件按因果顺序完整          | 14       |
// | 坏数据大声失败                  | 15       |
// | executor 独立守门（三向）       | 16–18    |
// | 模型无法夹带权限                | 19       |
// | 崩溃恢复复用执行                | 20       |
// | 失败不谎报 executed             | 21       |
// | 策略漂移阻断陈旧单              | 22       |
// | 未遂事件留痕                    | 23       |
//
// 值得注意的对照：这些测试没有一条在验证"模型输出什么"。
// 模型的部分（提案质量）留给第 8 章的评测方法；
// 本章守护的是"无论模型说什么，边界都成立"。
// ============================================================
