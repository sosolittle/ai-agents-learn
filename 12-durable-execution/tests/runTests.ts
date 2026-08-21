// ============================================================
//  第十二章测试：验证"崩溃后只退一次"的全部不变量
//
//  🏠 生活化比喻：请来的「事故调查组」。不只重演正常演出，
//  还专门人工制造车祸现场——把半勾的白板、重复编号的发票、
//  乱序的进度直接塞进档案柜，然后围观系统是报警还是装死。
//  崩溃恢复这类机制，没出过事故就不算验证过；
//  测试的职责是把所有可能的事故提前出一遍。
//
//  测试重点：
//  1. 正常路径、崩溃路径、恢复路径的最终副作用计数都正确
//  2. 两条幂等边界（工作流启动 / 步骤执行）各自独立有效
//  3. Schema 层的持久化不变量（前缀、context 一致性、
//     type-step 配对）真的拦得住坏数据
//  4. 账本冲突时 fail closed（报错而不是再造一条）
//
//  和 11 章测试一样的两条原则：
//  1. 零框架：迷你 test() runner（见下）
//  2. 临时目录隔离：每个测试独立的 DataPaths
//
//  本章测试的独特之处——"手工造状态"是主要手段：
//  为了测崩溃窗口，测试直接把"半完成"的工作流/账本
//  写进磁盘，然后验证系统的反应。因为本章的敌人
//  就是"磁盘上不一致的中间态"，测试必须能制造它们。
// ============================================================

import assert from "node:assert/strict";
// Node 内置断言（strict 模式）。
import { mkdtempSync, writeFileSync } from "node:fs";
// writeFileSync 在这里不是辅助——它是"状态伪造器"：
// 直接把精心构造的 JSON 写进 store，模拟崩溃残留/手改数据。
import { tmpdir } from "node:os";
import path from "node:path";

import { findWorkflow, findWorkflowByApprovalId, loadWorkflows } from "../checkpointStore.js";
import type { DataPaths } from "../config.js";
import {
  appendEffect,
  countEffectsByType,
  findEffectByKey,
  idempotencyKey,
  loadEffects,
} from "../effectStore.js";
import { loadEventsForWorkflow } from "../eventLog.js";
import { mockConfirmationProvider, mockRefundProvider, validateApproval } from "../steps.js";
import type { EffectRecord, WorkflowInput } from "../types.js";
import {
  createWorkflow,
  resumeWorkflow,
  runWorkflow,
  SimulatedCrashError,
} from "../workflowRunner.js";

// 这些测试在运行工作流时不调用模型、不需要 OpenAI Key。
// 每个测试都有自己独立的临时数据目录，
// 所以提交在 ./data 下的演示文件永远不会被碰。

function tempPaths(): DataPaths {
  const dir = mkdtempSync(path.join(tmpdir(), "durable-execution-test-"));
  // 随机后缀临时目录（与 11 章测试同款隔离手法）。
  return {
    workflows: path.join(dir, "workflows.json"),
    effects: path.join(dir, "effects.json"),
    events: path.join(dir, "events.json"),
  };
}

function approvedAction(
  // 测试数据工厂：返回一个合法的 ApprovedAction，
  // 用 overrides 覆盖个别字段制造各种变体。
  // 默认参数 + ?? 的组合让每个测试只声明"我关心哪个字段"。
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
    // 大多数测试用默认 approved；测验证逻辑时传 "pending"。
    toolName: "refundOrder",
    arguments: {
      orderId: overrides.orderId ?? "ORD-001",
      amount: overrides.amount ?? 49,
      currency: overrides.currency ?? "EUR",
      reason: overrides.reason ?? "Partial refund approved after review",
    },
  };
  // 返回类型刻意不标注 ApprovedAction——
  // overrides.status 是 string（比联合宽），
  // 而且这个对象要走的 createWorkflow 参数是 unknown
  // （结构层放宽、业务层收紧——和 types.ts 的分层呼应）。
}

function validInput(overrides: Partial<WorkflowInput> = {}): WorkflowInput {
  // WorkflowInput 的测试工厂（给 steps 的 provider 直接喂输入用）。
  // Partial<WorkflowInput>：全部字段可选——
  // 调用方只覆盖关心的字段，其余展开在后面补全默认值。
  // 注意默认值写在【前】、overrides 展开在【后】：
  // 后展开的覆盖先写的，overrides 才能生效。顺序反了就永远默认值。
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

/** 一个原始的、可 JSON 序列化的工作流记录，用于把持久化状态直接手写到磁盘。 */
function rawWorkflow(overrides: Record<string, unknown> = {}) {
  // 与前两个工厂不同，rawWorkflow 产出的是"未类型化"的对象
  // （Record<string, unknown> 覆盖）——
  // 它的使命是绕过一切类型检查，直接落盘。
  // 因为要测的就是"Schema 面对任意磁盘数据时的反应"。
  const now = new Date().toISOString();
  return {
    id: "WF-001",
    status: "running",
    input: validInput(),
    completedSteps: [] as string[],
    // as string[]：让 TS 把 [] 推成 string[] 而不是 never[]，
    // 后面 overrides 替换时不报类型错。
    context: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** createWorkflow + runWorkflow 组合，并把崩溃注入在 execute_refund。 */
function createAndCrash(paths: DataPaths, action = approvedAction()) {
  // 最常用的剧本函数：一章测试里十几处"崩溃现场"
  // 都靠它一键布置。
  const { workflow } = createWorkflow(paths, action);
  let crashed = false;
  try {
    runWorkflow(paths, workflow.id, { crashAfterSideEffectStep: "execute_refund" });
  } catch (error) {
    if (!(error instanceof SimulatedCrashError)) throw error;
    // 只吞模拟崩溃，其他异常继续抛（不掩盖真实 bug）。
    crashed = true;
  }
  assert.ok(crashed, "expected a SimulatedCrashError during execute_refund");
  // 自检：崩溃确实发生了（否则后续断言全在测错误的东西）。
  return workflow.id;
}

// ── 迷你测试运行器 ─────────────────────────────────────────────────────────
// 与 11 章完全相同的 20 行 runner（登记/执行/计数/报告/退出码）。

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
    // 失败只显示第一行错误，清单不被淹没；
    // 不抛出不中断——跑完所有测试再统一报告。
  }
}

console.log("\nDurable Execution — tests\n");

// ── 第一组：正常路径 / 崩溃 / 恢复 ─────────────────────────────────────────

test("approved input validates and the workflow completes", () => {
  // 基线测试：没有崩溃时三步全绿。
  const paths = tempPaths();
  const { workflow } = createWorkflow(paths, approvedAction());
  const { workflow: finished } = runWorkflow(paths, workflow.id);
  assert.equal(finished.status, "completed");
  assert.deepEqual(finished.completedSteps, [
    // deepEqual 连顺序一起验——前缀不变量的正面形态。
    "validate_approval",
    "execute_refund",
    "send_confirmation",
  ]);
});

test("a pending approval cannot start", () => {
  // 业务校验第一弹：pending 的审批进不了执行阶段。
  const paths = tempPaths();
  const { workflow } = createWorkflow(paths, approvedAction({ status: "pending" }));
  // createWorkflow 只做结构校验，pending 能建档——
  // 但第一步 validate_approval 的业务 Schema 只收 approved。
  assert.throws(() => runWorkflow(paths, workflow.id), /approvalStatus must be "approved"/);
  const record = findWorkflow(paths, workflow.id);
  assert.equal(record?.status, "failed");
  // 业务失败被活着进程记录为 failed（对比崩溃保持 running）。
  assert.equal(countEffectsByType(paths, "refund"), 0);
  assert.equal(countEffectsByType(paths, "confirmation"), 0);
  // 验证失败在退款之前——零副作用。
  // 这就是"纯步骤当门卫"的价值：它挡在所有副作用前面。
});

test("a rejected approval cannot start", () => {
  // 同款验证：rejected 一样进不去。
  const paths = tempPaths();
  const { workflow } = createWorkflow(paths, approvedAction({ status: "rejected" }));
  assert.throws(() => runWorkflow(paths, workflow.id), /approvalStatus must be "approved"/);
  assert.equal(findWorkflow(paths, workflow.id)?.status, "failed");
});

test("validate_approval checkpoints before execute_refund crashes", () => {
  // 崩溃现场的基础事实：纯步骤的 checkpoint 已经落盘。
  const paths = tempPaths();
  const id = createAndCrash(paths);
  const record = findWorkflow(paths, id);
  assert.ok(record?.completedSteps.includes("validate_approval"));
  // 为什么这个断言重要？
  // 它确认崩溃点选在了"纯步骤完成之后、副作用步骤完成之前"
  // ——正是设计的窗口。如果崩溃更早，恢复要多跑一步；
  // 如果更晚，窗口就不存在了。
});

test("crash lands after the refund side effect but before the checkpoint", () => {
  // 本模块存在理由的测试化：窗口两侧的精确状态。
  const paths = tempPaths();
  const id = createAndCrash(paths);

  const effect = findEffectByKey(paths, idempotencyKey(id, "execute_refund"));
  assert.ok(effect, "the refund effect must already exist");
  // 窗口右侧：账本里退款已发生。

  const record = findWorkflow(paths, id);
  assert.ok(!record?.completedSteps.includes("execute_refund"));
  // 窗口左侧：checkpoint 说没完成。
  assert.notEqual(record?.status, "completed");
  assert.equal(record?.status, "running");
  // 且状态仍是 running（崩溃不产生 "crashed"）。
  // 左右两半合起来 = "天真重试会双倍退款"的完整前提。
});

test("resume retries the incomplete step, not validate_approval again", () => {
  // 恢复从正确的位置开始：不重跑已完成的纯步骤。
  const paths = tempPaths();
  const id = createAndCrash(paths);
  resumeWorkflow(paths, id);

  const events = loadEventsForWorkflow(paths, id);
  const resumedIndex = events.findIndex((e) => e.event === "WORKFLOW_RESUMED");
  const nextStepStarted = events.slice(resumedIndex + 1).find((e) => e.event === "STEP_STARTED");
  // 时间线取证：WORKFLOW_RESUMED 之后的第一个 STEP_STARTED 是哪步？
  assert.equal(nextStepStarted?.step, "execute_refund");
  // 是 execute_refund（崩溃的那步），不是 validate_approval。
  // checkpoint 的"记住走到哪"职能的直接证据。
});

test("repeated refund reuses the existing side effect", () => {
  // ★ 本章的招牌断言：崩溃 + 恢复之后，退款仍只有一次。
  const paths = tempPaths();
  const id = createAndCrash(paths);
  assert.equal(countEffectsByType(paths, "refund"), 1);
  // 崩溃时（真实）退款一次。
  resumeWorkflow(paths, id);
  assert.equal(countEffectsByType(paths, "refund"), 1);
  // 恢复重跑 execute_refund 后……还是一次！
  // 第二次运行命中幂等键（SIDE_EFFECT_REUSED），没有新 REF。
});

test("the recovered refund uses the same refund ID", () => {
  // 复用不只是"数量没变"，连身份都没变。
  const paths = tempPaths();
  const id = createAndCrash(paths);
  const before = findEffectByKey(paths, idempotencyKey(id, "execute_refund"));
  const refundIdBefore = before?.type === "refund" ? before.result.refundId : undefined;
  assert.equal(refundIdBefore, "REF-001");

  const { workflow } = resumeWorkflow(paths, id);
  assert.equal(workflow.context.refundId, "REF-001");
  // 恢复后 context 里记录的还是同一个 REF-001——
  // 客户收到的退款单号不会因为崩溃+恢复而变化。
});

test("SIDE_EFFECT_REUSED is audited for execute_refund on resume", () => {
  // 幂等命中要在事件日志里可见。
  const paths = tempPaths();
  const id = createAndCrash(paths);
  resumeWorkflow(paths, id);

  const events = loadEventsForWorkflow(paths, id);
  const reused = events.find((e) => e.event === "SIDE_EFFECT_REUSED" && e.step === "execute_refund");
  assert.ok(reused);
  // EXECUTED（首次）/ REUSED（恢复）分开记录——
  // 数一下 REUSED 的数量就知道"系统挡下了几次重复"。
});

test("send_confirmation executes exactly one local effect", () => {
  // 第二个副作用步骤同样只发生一次（正常路径）。
  const paths = tempPaths();
  const { workflow } = createWorkflow(paths, approvedAction());
  runWorkflow(paths, workflow.id);
  assert.equal(countEffectsByType(paths, "confirmation"), 1);
});

test("resuming a completed workflow is a no-op", () => {
  // 已完成再 resume：什么都不发生（noop 标志 + 零新副作用）。
  const paths = tempPaths();
  const { workflow } = createWorkflow(paths, approvedAction());
  runWorkflow(paths, workflow.id);

  const refundsBefore = countEffectsByType(paths, "refund");
  const confirmationsBefore = countEffectsByType(paths, "confirmation");
  // 先拍快照。

  const { workflow: again, noop } = resumeWorkflow(paths, workflow.id);
  assert.equal(noop, true);
  // 显式 noop 标志（advance 的第一分支）。
  assert.equal(again.status, "completed");
  assert.equal(countEffectsByType(paths, "refund"), refundsBefore);
  assert.equal(countEffectsByType(paths, "confirmation"), confirmationsBefore);
  // 前后计数一致：没有重复副作用。
});

test("resuming twice after completion never duplicates effects", () => {
  // 更狠的重复轰炸：崩溃恢复完成后，再 resume 两次。
  const paths = tempPaths();
  const id = createAndCrash(paths);
  resumeWorkflow(paths, id);
  resumeWorkflow(paths, id);
  assert.equal(countEffectsByType(paths, "refund"), 1);
  assert.equal(countEffectsByType(paths, "confirmation"), 1);
  // 两个幂等边界接力兜底：
  //   resume 完成的 → no-op（边界 A 层面）
  //   即便进了步骤 → 幂等键命中（边界 B 层面）
});

// ── 第二组：两条幂等边界——工作流启动 vs 步骤执行 ─────────────────────────

test("the same approval does not create two workflows", () => {
  // 幂等边界 A：同一审批两次提交 → 一个工作流。
  const paths = tempPaths();
  const first = createWorkflow(paths, approvedAction({ approvalId: "APR-001" }));
  const second = createWorkflow(paths, approvedAction({ approvalId: "APR-001" }));

  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(second.workflow.id, first.workflow.id);
  // 第二次拿到的是同一个 WF（reused: true）。
  assert.equal(loadWorkflows(paths).length, 1);
  // 存储里只有一条工作流记录。

  runWorkflow(paths, first.workflow.id);
  assert.equal(countEffectsByType(paths, "refund"), 1);
  // 双重保险验证：即使两次提交都被运行，退款也只有一笔。
});

test("different approvals create different workflows", () => {
  // 边界 A 的反面：不同审批 → 不同工作流。
  // （幂等折叠不能矫枉过正——把合法的不同业务混成一条。）
  const paths = tempPaths();
  const wf1 = createWorkflow(paths, approvedAction({ approvalId: "APR-001" }));
  const wf2 = createWorkflow(paths, approvedAction({ approvalId: "APR-002" }));
  assert.notEqual(wf1.workflow.id, wf2.workflow.id);
  assert.equal(wf1.reused, false);
  assert.equal(wf2.reused, false);
  assert.equal(loadWorkflows(paths).length, 2);
});

test("findWorkflowByApprovalId finds the workflow created for that approval", () => {
  // 边界 A 依赖的查找函数本身正确。
  const paths = tempPaths();
  const { workflow } = createWorkflow(paths, approvedAction({ approvalId: "APR-001" }));
  assert.equal(findWorkflowByApprovalId(paths, "APR-001")?.id, workflow.id);
  assert.equal(findWorkflowByApprovalId(paths, "APR-999"), undefined);
  // 查不存在的审批返回 undefined（不是抛错——查询语义）。
});

// 不同工作流（来自不同审批）仍然获得各自独立的
// 步骤级幂等键。这刻意不是"同一审批提交两次"——
// 那条重复启动路径上面已覆盖，是与这里分开的边界。
test("idempotency keys are workflow-specific", () => {
  // 幂等边界 B 的作用域测试：键跟工作流走。
  const paths = tempPaths();
  const { workflow: wf1 } = createWorkflow(paths, approvedAction({ approvalId: "APR-001" }));
  runWorkflow(paths, wf1.id);
  const { workflow: wf2 } = createWorkflow(paths, approvedAction({ approvalId: "APR-002" }));
  runWorkflow(paths, wf2.id);
  // 两个合法工作流各跑一遍。

  const effect1 = findEffectByKey(paths, idempotencyKey(wf1.id, "execute_refund"));
  const effect2 = findEffectByKey(paths, idempotencyKey(wf2.id, "execute_refund"));
  assert.ok(effect1 && effect2);
  assert.notEqual(effect1.key, effect2.key);
  // WF-001:execute_refund ≠ WF-002:execute_refund——
  // 不同工作流的"同名步骤"键不同，互不串账。
  const id1 = effect1.type === "refund" ? effect1.result.refundId : undefined;
  const id2 = effect2.type === "refund" ? effect2.result.refundId : undefined;
  assert.notEqual(id1, id2);
  assert.equal(countEffectsByType(paths, "refund"), 2);
  // 两个退款单、两个不同 REF 编号——这是正确行为：
  // 两笔合法业务就应有两次合法退款。
});

// ── 第三组：持久化与校验边界 ───────────────────────────────────────────────

test("the mock refund provider returns the same result for a repeated key", () => {
  // 提供方级幂等（不经 runner，直连测试）：
  const paths = tempPaths();
  const input = validInput();
  const first = mockRefundProvider(paths, "WF-001", input);
  const second = mockRefundProvider(paths, "WF-001", input);
  assert.equal(first.reused, false);
  // 第一次：真实执行。
  assert.equal(second.reused, true);
  // 第二次同键：复用。
  assert.equal(first.result.refundId, second.result.refundId);
  // 同一个退款 ID。
  assert.equal(countEffectsByType(paths, "refund"), 1);
  // 账本一条。
});

test("malformed workflow JSON produces a clear error", () => {
  // 坏 JSON → 明确报错（不是静默当空）。
  const paths = tempPaths();
  writeFileSync(paths.workflows, "{ this is not valid json", "utf8");
  assert.throws(() => loadWorkflows(paths), /malformed JSON/);
});

test("malformed effects JSON produces a clear error", () => {
  // 账本坏 JSON 同样报错——尤其重要：
  // 账本被静默清空 = 幂等保护消失 = 双倍退款风险。
  const paths = tempPaths();
  writeFileSync(paths.effects, "{ not json", "utf8");
  assert.throws(() => loadEffects(paths), /malformed JSON/);
});

test("an invalid persisted workflow schema fails validation", () => {
  // JSON 合法但结构不对（status: "banana"）→ 结构 Schema 拦截。
  const paths = tempPaths();
  writeFileSync(paths.workflows, JSON.stringify([{ status: "banana" }]), "utf8");
  assert.throws(() => loadWorkflows(paths), /invalid shape/);
});

test("an unknown workflow ID gives an actionable error", () => {
  // 恢复不存在的 ID → 带指引的错误。
  const paths = tempPaths();
  assert.throws(() => resumeWorkflow(paths, "WF-999"), /No workflow found with id "WF-999"/);
});

test("failed validation creates no side effects", () => {
  // pending 审批 → failed 工作流 → 零副作用（与第 2 个测试呼应，
  // 这次显式验证副作用计数）。
  const paths = tempPaths();
  const { workflow } = createWorkflow(paths, approvedAction({ status: "pending" }));
  assert.throws(() => runWorkflow(paths, workflow.id));
  assert.equal(countEffectsByType(paths, "refund"), 0);
  assert.equal(countEffectsByType(paths, "confirmation"), 0);
});

test("a completed workflow's context contains the expected IDs", () => {
  // 完成态的完整形状：两个结果 ID 都进了 context。
  const paths = tempPaths();
  const { workflow } = createWorkflow(paths, approvedAction());
  const { workflow: finished } = runWorkflow(paths, workflow.id);
  assert.equal(finished.context.refundId, "REF-001");
  assert.equal(finished.context.confirmationId, "MSG-001");
});

test("event ordering is correct across crash and resume", () => {
  // ★ 时间线的全序断言：崩溃+恢复的完整事件序列一字不差。
  const paths = tempPaths();
  const id = createAndCrash(paths);
  resumeWorkflow(paths, id);

  const events = loadEventsForWorkflow(paths, id).map((e) => e.event);
  assert.deepEqual(events, [
    "WORKFLOW_CREATED",        // 建档
    "WORKFLOW_STARTED",        // 首跑开始
    "STEP_STARTED",            // validate_approval
    "STEP_COMPLETED",          // validate_approval ✓
    "STEP_STARTED",            // execute_refund
    "SIDE_EFFECT_EXECUTED",    // 真实退款发生
    "WORKFLOW_RESUMED",        // ← 崩溃缺口后，新进程接手
    "STEP_STARTED",            // execute_refund（重跑）
    "SIDE_EFFECT_REUSED",      // 幂等命中！
    "STEP_COMPLETED",          // execute_refund ✓（这次checkpoint成功）
    "STEP_STARTED",            // send_confirmation
    "SIDE_EFFECT_EXECUTED",    // 真实通知发生
    "STEP_COMPLETED",          // send_confirmation ✓
    "WORKFLOW_COMPLETED",      // 收官
  ]);
  // 一条 deepEqual 锁死 14 行因果链。
  // 注意中间没有 STEP_FAILED——模拟崩溃不发失败事件，
  // 它的痕迹是 EXECUTED 和 RESUMED 之间的缺口本身。
});

// ── 第四组：validate_approval 业务规则 ─────────────────────────────────────

// 五个小测试逐一验证业务 Schema 的每条规则。
// 写法统一：validInput({字段:坏值}) → 应抛对应错误。
// 这组测试的价值不在覆盖（Schema 声明了规则），
// 而在【钉死】——防止有人无意中放宽规则。

test("a non-positive amount fails validate_approval", () => {
  assert.throws(() => validateApproval(validInput({ amount: 0 })), /amount must be greater than 0/);
  assert.throws(() => validateApproval(validInput({ amount: -10 })), /amount must be greater than 0/);
  // 0 和负数都不行（0 元退款没有业务意义）。
});

test("an unsupported currency fails validate_approval", () => {
  assert.throws(() => validateApproval(validInput({ currency: "USD" })), /currency must be "EUR"/);
});

test("a malformed order ID fails validate_approval", () => {
  assert.throws(() => validateApproval(validInput({ orderId: "not-an-order" })), /orderId must look like/);
});

test("a malformed approval ID fails validate_approval", () => {
  assert.throws(
    () => validateApproval(validInput({ approvalId: "not-an-approval" })),
    /approvalId must look like/
  );
});

test("an empty reason fails validate_approval", () => {
  assert.throws(() => validateApproval(validInput({ reason: "" })), /reason must be non-empty/);
});

test("the mock confirmation provider is idempotent", () => {
  // 确认提供方的幂等（与退款提供方对称）。
  const paths = tempPaths();
  const input = validInput();
  const first = mockConfirmationProvider(paths, "WF-001", input);
  const second = mockConfirmationProvider(paths, "WF-001", input);
  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(first.result.confirmationId, second.result.confirmationId);
  assert.equal(countEffectsByType(paths, "confirmation"), 1);
});

test("missing persistence files are treated as empty", () => {
  // 三态之一：文件不存在 = 空店（全新环境的正常态）。
  const paths = tempPaths();
  assert.deepEqual(loadWorkflows(paths), []);
  assert.deepEqual(loadEffects(paths), []);
  assert.deepEqual(loadEventsForWorkflow(paths, "WF-001"), []);
});

test("empty persistence files are treated as empty", () => {
  // 三态之二：空文件 = 空店。
  const paths = tempPaths();
  writeFileSync(paths.workflows, "", "utf8");
  assert.deepEqual(loadWorkflows(paths), []);
});

// ── 第五组：completedSteps 前缀不变量 ──────────────────────────────────────
// 用 rawWorkflow 手工造三种非法前缀，验证 superRefine 拒绝它们。

test("a workflow record with out-of-order completedSteps fails to load", () => {
  const paths = tempPaths();
  // 跳过中间步骤：validate_approval 直接跳到 send_confirmation。
  writeFileSync(
    paths.workflows,
    JSON.stringify([rawWorkflow({ completedSteps: ["validate_approval", "send_confirmation"] })]),
    "utf8"
  );
  assert.throws(() => loadWorkflows(paths), /ordered prefix/);
});

test("a workflow record that skips the first step fails to load", () => {
  const paths = tempPaths();
  // 连第一步都没跑就"完成"了退款——乱序的另一种形态。
  writeFileSync(
    paths.workflows,
    JSON.stringify([rawWorkflow({ completedSteps: ["execute_refund"] })]),
    "utf8"
  );
  assert.throws(() => loadWorkflows(paths), /ordered prefix/);
});

test("a workflow record with a duplicated step fails to load", () => {
  const paths = tempPaths();
  // 重复步骤：两次 checkpoint 同一步（bug 的痕迹）。
  writeFileSync(
    paths.workflows,
    JSON.stringify([
      rawWorkflow({
        completedSteps: ["validate_approval", "execute_refund", "execute_refund"],
        context: { refundId: "REF-001" },
        // context 配齐也没用——前缀校验先把它拦了。
      }),
    ]),
    "utf8"
  );
  assert.throws(() => loadWorkflows(paths), /ordered prefix/);
});

// ── 第六组：context 一致性不变量 ───────────────────────────────────────────
// 完成的步骤必须有结果；"completed"必须诚实。

test("execute_refund completed without a refundId in context fails to load", () => {
  const paths = tempPaths();
  // 说退款完成了、context 却没有退款单号——谎报完成。
  writeFileSync(
    paths.workflows,
    JSON.stringify([
      rawWorkflow({ completedSteps: ["validate_approval", "execute_refund"], context: {} }),
    ]),
    "utf8"
  );
  assert.throws(() => loadWorkflows(paths), /refundId is missing/);
});

test("send_confirmation completed without a confirmationId in context fails to load", () => {
  const paths = tempPaths();
  writeFileSync(
    paths.workflows,
    JSON.stringify([
      rawWorkflow({
        completedSteps: ["validate_approval", "execute_refund", "send_confirmation"],
        context: { refundId: "REF-001" },
      }),
    ]),
    "utf8"
  );
  assert.throws(() => loadWorkflows(paths), /confirmationId is missing/);
});

test('status "completed" with incomplete steps fails to load', () => {
  const paths = tempPaths();
  // 只完成一步却宣称 completed——最危险的谎报
  // （恢复程序会以为无事可做直接跳过）。
  writeFileSync(
    paths.workflows,
    JSON.stringify([
      rawWorkflow({ status: "completed", completedSteps: ["validate_approval"], context: {} }),
    ]),
    "utf8"
  );
  assert.throws(() => loadWorkflows(paths), /not every workflow step/);
});

test("the dangerous crash-window state remains a valid persisted workflow", () => {
  // ★ 前面的测试都在证"坏状态进不来"——
  // 这个测试反过来证"关键的好状态不被误伤"：
  // 崩溃窗口的合法形态必须能通过校验。
  const paths = tempPaths();
  // status "running"、只有 validate_approval 被 checkpoint、
  // 空 context——但账本里已独立存在一笔退款 effect。
  // 这个差距（提供方先知道、checkpoint 后知道）正是崩溃
  // 演示所依赖的，所以 Schema 绝不能拒绝它。
  //
  // 为什么这是"最重要的反向测试"？
  //   一个过于严格的 superRefine（比如要求
  //   "账本有 effect ⇒ context 必须有 ID"）会让
  //   崩溃现场无法加载——恢复机制直接瘫痪。
  //   校验要严在"谎报"，松在"滞后"——
  //   谎报是 bug，滞后是常态。
  writeFileSync(
    paths.workflows,
    JSON.stringify([rawWorkflow({ completedSteps: ["validate_approval"], context: {} })]),
    "utf8"
  );

  const refundEffect: EffectRecord = {
    // 手工把退款 effect 写进账本（跳过 provider，
    // 直接触达 appendEffect 的底层或直接落盘）。
    key: idempotencyKey("WF-001", "execute_refund"),
    workflowId: "WF-001",
    step: "execute_refund",
    type: "refund",
    result: {
      refundId: "REF-001",
      orderId: "ORD-001",
      amount: 49,
      currency: "EUR",
      status: "processed",
      mock: true,
    },
    createdAt: new Date().toISOString(),
  };
  writeFileSync(paths.effects, JSON.stringify([refundEffect]), "utf8");

  const workflows = loadWorkflows(paths);
  // 两边都能独立加载（不抛错）：
  assert.equal(workflows.length, 1);
  assert.deepEqual(workflows[0].completedSteps, ["validate_approval"]);
  assert.deepEqual(workflows[0].context, {});

  const effects = loadEffects(paths);
  assert.equal(effects.length, 1);
  assert.equal(effects[0].key, "WF-001:execute_refund");
  // 这就是崩溃窗口的持久化全貌——
  // 后续的 resume 测试证明系统恰好能处理它。
});

// ── 第七组：effect 记录不变量 ──────────────────────────────────────────────

test("a refund-typed effect record with the wrong step fails to load", () => {
  // type 与 step 必须配对（判别联合的 literal 钉死）：
  // refund 类型挂在 send_confirmation 步骤上 → 拒绝加载。
  const paths = tempPaths();
  const bad = {
    key: "WF-001:send_confirmation",
    workflowId: "WF-001",
    step: "send_confirmation",
    type: "refund",
    // ← 错配：refund 只允许 step: "execute_refund"
    result: {
      refundId: "REF-001",
      orderId: "ORD-001",
      amount: 49,
      currency: "EUR",
      status: "processed",
      mock: true,
    },
    createdAt: new Date().toISOString(),
  };
  writeFileSync(paths.effects, JSON.stringify([bad]), "utf8");
  assert.throws(() => loadEffects(paths), /invalid shape/);
});

test("a confirmation-typed effect record with the wrong step fails to load", () => {
  // 对称的另一半：confirmation 挂在 execute_refund 上 → 拒绝。
  const paths = tempPaths();
  const bad = {
    key: "WF-001:execute_refund",
    workflowId: "WF-001",
    step: "execute_refund",
    type: "confirmation",
    // ← 错配的另一个方向
    result: {
      confirmationId: "MSG-001",
      orderId: "ORD-001",
      status: "sent",
      mock: true,
    },
    createdAt: new Date().toISOString(),
  };
  writeFileSync(paths.effects, JSON.stringify([bad]), "utf8");
  assert.throws(() => loadEffects(paths), /invalid shape/);
});

test("a wrong-type effect planted at the refund key produces a clear collision error", () => {
  // fail closed 实测：退款键下躺着确认记录 → 提供方报碰撞错误。
  const paths = tempPaths();
  // Simulate a corrupted ledger: a confirmation effect sitting under the key
  // the refund provider would look up. This is not something normal code
  // produces (appendEffect and the provider always agree on key <-> type),
  // but the provider must still fail closed rather than silently create a
  // second refund effect under the same key.
  // （模拟被污染的账本：一个确认 effect 占据了退款提供方
  //  要查的键。正常代码不会产生它（appendEffect 和提供方
  //  对键↔类型的约定一致），但提供方仍必须 fail closed，
  //  而不是在同键下悄悄创建第二个退款 effect。）
  appendEffect(paths, {
    // 用正常 API 种下"错位"记录（appendEffect 只查键唯一，
    // 不校验键与内容语义的匹配——那是 provider 层的检查）。
    key: idempotencyKey("WF-001", "execute_refund"),
    workflowId: "WF-001",
    step: "send_confirmation",
    type: "confirmation",
    result: {
      confirmationId: "MSG-001",
      orderId: "ORD-001",
      status: "sent",
      mock: true,
    },
    createdAt: new Date().toISOString(),
  });

  assert.throws(
    () => mockRefundProvider(paths, "WF-001", validInput()),
    /Idempotency key collision/
    // provider 的 fail closed：报"键碰撞"，绝不静默补第二条。
  );
  assert.equal(countEffectsByType(paths, "refund"), 0);
  assert.equal(loadEffects(paths).length, 1);
  // 账本原样：一条确认记录，零条退款记录。
});

test("appendEffect refuses to append a second record for the same key", () => {
  // appendEffect 的最后防线：同键第二条直接拒绝。
  const paths = tempPaths();
  const effect: EffectRecord = {
    key: idempotencyKey("WF-001", "execute_refund"),
    workflowId: "WF-001",
    step: "execute_refund",
    type: "refund",
    result: {
      refundId: "REF-001",
      orderId: "ORD-001",
      amount: 49,
      currency: "EUR",
      status: "processed",
      mock: true,
    },
    createdAt: new Date().toISOString(),
  };
  appendEffect(paths, effect);
  assert.throws(() => appendEffect(paths, effect), /Refusing to append a second effect/);
  // 同一条记录追加两次 → 第二次被拒。
  assert.equal(loadEffects(paths).length, 1);
});

// ── 汇总 ──────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
// 非零退出码给 npm/CI 识别失败（与 11 章相同）。

// ============================================================
//  本文件小结：43 个测试锁死的不变量地图
// ============================================================
//
// | 组别           | 锁死什么                           |
// |----------------|------------------------------------|
// | 正常/崩溃/恢复 | 崩溃后退款仍恰一次；恢复点正确；    |
// |                | REUSED 事件可观测；完成态 no-op     |
// | 两条幂等边界   | 同审批→一工作流；不同审批不串账；  |
// |                | 键跟工作流走                        |
// | 持久化边界     | 坏 JSON/坏结构大声失败；            |
// |                | 完整时间线一字不差                  |
// | 业务规则       | pending/rejected/坏金额/坏币种全拒 |
// | 前缀不变量     | 跳步/乱序/重复的 checkpoint 拒载    |
// | context 一致性 | 谎报完成拒载；崩溃窗口合法放行 ★   |
// | effect 不变量  | type-step 配对强制；键碰撞 fail     |
// |                | closed；一键一记录                  |
//
// 最值得回味的一对测试：
//   "status completed with incomplete steps fails to load"（谎报→拒）
//   "the dangerous crash-window state remains valid"（滞后→收）
// 校验的艺术不在严，而在【严对地方】。
// ============================================================
