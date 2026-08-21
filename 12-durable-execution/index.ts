// ============================================================
//  第十二章入口：durable execution（持久执行）
//  一次文件里读完整个"崩溃 → 恢复"故事
//
//  🏠 生活化比喻——一场排好的「两幕话剧」（贯穿全章的主比喻）：
//    序幕  后台拿到第 11 章签好字的批条（已批准的退款单）；
//    一幕  戏演到一半——退款的钱已经汇出（REF-001 落账），
//          剧场突然断电（模拟崩溃），进度白板停在
//          "execute_refund 未完成"；
//    幕间  观众上台看现场：白板和账本对不上——
//          白板说没退过款、账本说钱已汇出。矛盾就是断电的伤口；
//    二幕  换一批人马（新进程）重新开演，从断的地方接着演：
//          退款一步凭小票（幂等键）认账不重付，
//          然后发通知、谢幕；
//    尾声  对账：无论断电多少次，钱只出过一笔、通知只发过一封。
//
//  学习目标：
//  1. 走完完整时间线：
//     已批准动作 → 创建工作流 → 注入崩溃 → 查看持久化状态
//     → 模拟重启 → 恢复 → 验证"只退一次"
//  2. 亲眼看到两个幂等边界：
//     再跑一次 npm start 不会新建工作流（边界 A）
//     崩溃后重跑 execute_refund 不会二次退款（边界 B）
//  3. 理解"两幕剧"结构：phase 1 崩溃、phase 2 重启恢复
//  4. 记住：本文件没有模型调用——
//     持久执行从"提案已被授权之后"开始
//
//  📤 输入输出走查（npm start 首次运行的完整时间线）：
//    序幕  打印批条 APR-001（amount=49）→ 创建工作流 WF-001
//    一幕  validate_approval ✓ → execute_refund 汇款 49 欧
//          （effects.json 记下 WF-001:execute_refund → REF-001）
//          → 💥 模拟崩溃：白板没来得及勾掉这一步
//    幕间  磁盘两边对质：
//            白板视角：  ✓ validate_approval
//                       ○ execute_refund     ← 副作用已发生但未勾！
//                       ○ send_confirmation
//            账本视角：  REF-001 已存在 ←→ 矛盾！
//    二幕  "重启"进程重读磁盘 → 从 execute_refund 恢复
//          → 幂等键命中（SIDE_EFFECT_REUSED，不再汇款）
//          → send_confirmation 发出 MSG-001 → 状态 completed
//    尾声  refund effects: 1, confirmation effects: 1
//          ——跑了两遍退款步骤，钱只出过一次
//
//  再跑一次 npm start：走进"已存在"分支（幂等边界 A 的演示）。
//  npm run reset 后这出戏可以无限重看。
//
//  运行方式：npm start（无需 .env、无需 API Key、全程离线）
// ============================================================

import { findWorkflow } from "./checkpointStore.js";
import { DEMO_APPROVED_ACTION, defaultPaths } from "./config.js";
// DEMO_APPROVED_ACTION：11 章交接来的"已批准退款"（见 config.ts 注释）。
import { countEffectsForWorkflowByType, loadEffectsForWorkflow } from "./effectStore.js";
import { WORKFLOW_STEPS } from "./types.js";
import { prettyJson, printSection } from "./utils.js";
import { createWorkflow, resumeWorkflow, runWorkflow, SimulatedCrashError } from "./workflowRunner.js";

// 一个文件里可读的完整崩溃/恢复故事。本文件任何地方都没有
// 模型调用——有趣的问题开始于一个提案已经被上一个控制层
// （第 11 章）提出并批准之后。持久执行是应用/运行时的
// 关注点，不是 prompt 能解决的东西。

function printStepList(completedSteps: readonly string[]): void {
  // 用 ✓/○ 打印三步骤的进度条。
  // 参数类型 readonly string[]：只读数组——
  // 打印函数不需要（也不应该）修改它。
  for (const step of WORKFLOW_STEPS) {
    // 遍历"定义顺序"而不是 completedSteps 本身：
    // 输出永远是三行，缺的显示 ○——
    // "完成了几步"和"还剩几步"一眼全见。
    const done = completedSteps.includes(step);
    console.log(`${done ? "✓" : "○"} ${step}`);
    // 崩溃后的预期输出：
    //   ✓ validate_approval
    //   ○ execute_refund     ← 副作用已发生但未 checkpoint！
    //   ○ send_confirmation
  }
}

function main(): void {
  // 注意不是 async：本章没有任何 await——
  // 全部是同步的文件读写。（11 章的 main 要 await 模型调用。）
  // 一个入口函数是否 async，直接暴露它有没有外部 I/O 等待。
  console.log("AI Agents From Scratch — 12 Durable Execution");
  const paths = defaultPaths();

  // ── 序幕：交代故事的前提 ────────────────────────────────────────────
  printSection("Approved action");
  console.log(prettyJson(DEMO_APPROVED_ACTION));
  console.log(
    "\nThis is where Module 12 begins — after the model proposed a refund and a " +
      "human already approved it in Module 11. There is no model call in this module."
  );
  // 明确告诉读者：故事从"已批准"开始，
  // 前情（提案/审批）在上一章。

  const { workflow, reused } = createWorkflow(paths, DEMO_APPROVED_ACTION);
  // 第一次运行：创建 WF-001，reused = false。
  // 第二次运行：命中审批幂等，reused = true（走下面的分支）。

  // 工作流启动幂等：这是一个与下面演示的步骤级幂等键
  // 【分开的】边界。它阻止同一个审批启动第二个工作流——
  // 所以跑两次 "npm start" 永远不会创建 WF-002，
  // 也不会为 APR-001 带来第二笔退款。
  if (reused) {
    // 幂等边界 A 的演示分支（第二次 npm start 会走进这里）：
    printSection("Workflow already exists");
    console.log(`${DEMO_APPROVED_ACTION.approvalId} already belongs to ${workflow.id}.`);
    console.log("\nNo new workflow was created.");
    console.log("No new refund was created.");
    // 两句 "No new" 直接陈述两个幂等边界的效果。
    console.log(`\nCurrent status: ${workflow.status}`);
    console.log(
      `${workflow.id} refund effects:       ${countEffectsForWorkflowByType(paths, workflow.id, "refund")}`
    );
    console.log(
      `${workflow.id} confirmation effects: ${countEffectsForWorkflowByType(paths, workflow.id, "confirmation")}`
    );
    // 数字应该是 1 和 1：无论崩溃、恢复、重复运行过多少次，
    // 这两个计数就是本章一切机制的最终成绩单。
    console.log("\nRun:\n  npm run reset\nto replay the crash demonstration from a clean state.");
    return;
    // 干净退出：没有新工作要展示，重置后才能重看故事。
  }

  printSection("Workflow created");
  console.log(workflow.id);
  // "WF-001" —— 故事的主角登场。

  // ── 第一幕：跑到注入的崩溃点 ────────────────────────────────────────
  // Phase 1: run until the injected crash. The crash lands right after the
  // refund provider succeeds and right before execute_refund is checkpointed —
  // the exact window where a naive retry would double-refund.
  // （第一阶段：一直跑到注入的崩溃。崩溃恰好落在退款提供方
  //  成功之后、execute_refund 被 checkpoint 之前——
  //  正是天真重试会造成双倍退款的那个窗口。）
  try {
    runWorkflow(paths, workflow.id, { crashAfterSideEffectStep: "execute_refund" });
    // 注入点：execute_refund 的副作用成功后立即"断电"。
  } catch (error) {
    if (!(error instanceof SimulatedCrashError)) throw error;
    // instanceof 检查分诊：只接住"模拟崩溃"。
    // 其他错误（真实 bug）照常上抛——
    // 演示代码不能把自己的意外也吞掉。
    printSection("💥 Simulated process crash");
    console.log(error.message);
    // 错误消息自带教学（见 workflowRunner 里构造器）。
    console.log("\nThe refund succeeded, but execute_refund was NOT checkpointed.");
    // 一句话点破窗口两侧的不对称：钱动了、记录没动。
  }

  const crashed = findWorkflow(paths, workflow.id);
  // 崩溃后重新从磁盘读记录——模拟"事后查案发现场"。
  if (!crashed) throw new Error(`Workflow ${workflow.id} vanished unexpectedly.`);

  printSection("Persisted state after the crash");
  printStepList(crashed.completedSteps);
  // 展示 checkpoint 视角：execute_refund 看起来"没做"。

  printSection("Side-effect ledger");
  for (const effect of loadEffectsForWorkflow(paths, workflow.id)) {
    const resultId = effect.type === "refund" ? effect.result.refundId : effect.result.confirmationId;
    // 判别联合收窄后按类型取结果 ID（不需要断言）。
    console.log(`${effect.key} → ${resultId}`);
    // 输出：WF-001:execute_refund → REF-001
    //
    // 和上面 checkpoint 对照——两个视角的矛盾一目了然：
    //   checkpoint 说：execute_refund 未完成
    //   账本说：       REF-001 已存在
    // 这个矛盾就是崩溃窗口，也是下一幕要解决的问题。
  }

  // ── 第二幕：模拟进程重启并恢复 ──────────────────────────────────────
  // Phase 2: simulate a process restart. Nothing here reuses `crashed` or any
  // other in-memory object from phase 1 — resumeWorkflow reloads the record
  // from disk itself, exactly as a freshly started process would.
  // （第二阶段：模拟进程重启。这里没有任何东西复用 `crashed`
  //  或第一阶段的任何内存对象——resumeWorkflow 自己从磁盘
  //  重新加载记录，就像一个全新启动的进程一样。）
  printSection("Process restarted");
  console.log(`Reloading ${workflow.id} from persisted state...`);
  const reloaded = findWorkflow(paths, workflow.id);
  // 故意再读一遍磁盘（而不是用上面的 crashed 变量）——
  // 在真实重启里，内存对象根本不存在，只有磁盘。
  // 演示代码的结构要诚实反映这一点。
  if (!reloaded) throw new Error(`Workflow ${workflow.id} vanished unexpectedly.`);
  const resumeStep = WORKFLOW_STEPS.find((step) => !reloaded.completedSteps.includes(step));
  // 手动算一遍恢复点（和 nextIncompleteStep 同逻辑）——
  // 只为了打印 "Resuming from: execute_refund" 给读者看。
  console.log(`Resuming from: ${resumeStep}`);

  const { workflow: finalWorkflow } = resumeWorkflow(paths, workflow.id);
  // 真正的恢复：重读磁盘 → execute_refund 幂等命中(REUSED)
  // → checkpoint → send_confirmation 正常执行 → completed。

  // ── 尾声：验收结果 ──────────────────────────────────────────────────
  printSection("Workflow completed");
  console.log(`${finalWorkflow.id}  [${finalWorkflow.status}]`);
  console.log(
    `\n${finalWorkflow.id} refund effects:       ${countEffectsForWorkflowByType(paths, finalWorkflow.id, "refund")}`
  );
  console.log(
    `${finalWorkflow.id} confirmation effects: ${countEffectsForWorkflowByType(paths, finalWorkflow.id, "confirmation")}`
  );
  // 关键数字：refund effects: 1, confirmation effects: 1。
  // 崩溃前后加起来跑了两遍 execute_refund（第一遍真执行、
  // 第二遍幂等命中），但真实副作用只有一次——
  // 这两个 1 就是"checkpoint + 幂等"协作的全部回报。

  printSection("Lesson");
  console.log("The checkpoint remembers where the workflow was.");
  console.log("The idempotency key prevents a replayed step from repeating the side effect.");
  // 两句话总结两件武器，与 README 开头的口号一一对应。
  console.log("\nInspect it further with:");
  console.log("  npm run status -- " + workflow.id);
  console.log("  npm run effects");
  console.log("  npm run events -- " + workflow.id);
  // 引导继续探索：status 看 checkpoint、effects 看账本、
  // events 看时间线（包括崩溃缺口和 SIDE_EFFECT_REUSED）。
}

try {
  main();
} catch (error) {
  // 与 11 章同款的收尾：消息给人、退出码给机器。
  console.error("\nRun failed:", (error as Error).message);
  process.exitCode = 1;
}

// ============================================================
//  本文件小结：你刚才看的是什么
// ============================================================
//
//  幕  内容                        磁盘上发生了什么
//  序  打印已批准动作、创建 WF-001   workflows.json +1
//  一  跑到 execute_refund 后崩溃    effects.json +REF-001（checkpoint 未写）
//  幕间 展示两个视角的矛盾           —
//  二  重启、恢复                    workflows.json 更新至 completed、
//                                     effects.json +MSG-001
//  尾声 验收：REF×1 MSG×1           最终状态
//
//  再跑一次 npm start 会看到幂等边界 A（已存在分支）。
//  npm run reset 后可以无限重看。
// ============================================================
