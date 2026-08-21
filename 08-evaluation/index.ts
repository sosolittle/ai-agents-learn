// ============================================================
//  第八章入口：运行一组 eval cases（考务办公室）
//
//  🏠 生活化比喻（接着前七章的故事讲）：
//  前面造出的 agent，像一位刚培训完上岗的新员工——demo 跑得
//  漂漂亮亮。但「演示能过」和「可靠工作」之间，还差一场正式考试：
//    固定考题   → eval-cases.ts（每次都考同一套卷，可重复）
//    客观判卷   → evaluator.ts（判断题：代码判分，零误差零成本）
//    作文批改   → judge.ts（主观题：请另一个模型当老师打分）
//    草稿纸     → trace（agent 不只交答案，还交「怎么做的」）
//  本文件是考务办公室：发卷 → 收卷 → 判分 → 出成绩单，
//  并用 process.exitCode 把「有没有不及格」告诉 CI。
//
//  学习目标：
//  1. 理解评测不是只看“回答像不像”，还要检查工具调用轨迹
//  2. 学会把 agent 输出交给 deterministic evaluator 和可选 LLM judge
//  3. 看懂如何用 process.exitCode 让失败评测影响命令退出状态
//
//  本模块文件导航：
//  - index.ts（本文件）：跑全部用例 + 汇总 + exitCode
//  - eval-cases.ts：考卷（用户输入 + 期望行为）
//  - agent.ts：被测 agent（返回 AgentResult，不靠打印）
//  - tools.ts：固定数据的 mock 工具（保证标准答案唯一）
//  - trace.ts：执行轨迹（判卷的证据）
//  - evaluator.ts：确定性判卷机（六类检查）
//  - judge.ts：可选的 LLM 裁判（只管主观质量）
// ============================================================

// 08 起的模块是 ESM（package.json 声明 "type": "module"，用 tsx 运行）：
// import 自己项目里的文件必须写显式 .js 后缀——哪怕源文件是 .ts。
// 这是 Node ESM 的解析规则：编译成 .js 后路径要能原样对上。
// （01–07 的 CommonJS 模块没有这个要求，两代的区别之一。）
import { runAgent } from "./agent.js";
import { evalCases } from "./eval-cases.js";
import { evaluateCase } from "./evaluator.js";
import { judgeAnswer } from "./judge.js";

function icon(passed: boolean): string {
  // 小工具：把布尔结果变成终端里更容易扫读的符号。
  return passed ? "✅" : "❌";
}

async function main(): Promise<void> {
  console.log("AI Agents From Scratch — 08 Evaluation\n");
  console.log(`Running ${evalCases.length} eval cases...\n`);

  let passedCount = 0;
  for (const testCase of evalCases) {
    // 每个 testCase 都是一条“用户输入 + 期望行为”。
    // agent 先真实跑一遍，再由 evaluateCase 检查可验证条件。
    // 注意被测的是真 agent（真的调模型）——评测 agent 本身也要花 token，
    // 所以考卷不宜无限膨胀：每条用例都该有存在的理由。
    const result = await runAgent(testCase.input);
    // 客观题判分：查工具、查参数、查关键词、查迭代数、查停止原因。
    const report = evaluateCase(testCase, result);
    // 主观题批改：只有 useJudge: true 的用例才请裁判（省 token）。
    const judge = testCase.useJudge
      ? await judgeAnswer({
          input: testCase.input,
          finalAnswer: result.finalAnswer,
          trace: result.trace,
          rubric: testCase.judgeRubric ?? [],
        })
      : null;
    // LLM judge 只用于模糊质量判断，不能替代确定性检查。
    // 例如“有没有调用 getOrderStatus”应该直接看 trace，而不是问另一个模型。
    //
    // TS 语法：judge?.passed ?? true 读作「judge 存在且通过；不存在当通过」。
    // 裁判只在被请来时才有一票否决权——没请裁判的用例不该因为它挂掉。
    const passed = report.passed && (judge?.passed ?? true);
    if (passed) passedCount++;

    // 成绩单：用例名 + 每个小项的 ✅/❌ +（如有）裁判评语 + 答案预览。
    console.log(`${icon(passed)} ${testCase.name}`);
    for (const check of report.checks) {
      console.log(`   ${icon(check.passed)} ${check.message}`);
    }
    if (judge) {
      // toFixed(2)：把 0.9 显示成 "0.90"（保留两位小数的文本）。
      console.log(`   🤖 judge: ${judge.score.toFixed(2)} — ${judge.reasoning}`);
    }
    console.log(`   answer: ${report.finalAnswer || "(none)"}\n`);
  }

  console.log(`Summary: ${passedCount}/${evalCases.length} passed`);
  console.log(
    "Final answers are only one layer. For tool-calling agents, the trace is part of the behavior."
  );

  // TS 语法：process.exitCode = 1 是「安排退出码」，不是立刻退出——
  // main() 会自然跑完（后续清理逻辑有机会执行），进程结束时带上码 1。
  // 对比 process.exit(1)：立刻硬退。CI / shell 靠退出码判断评测成败。
  if (passedCount !== evalCases.length) process.exitCode = 1;
  // 设置 exitCode=1 后，CI 或脚本可以知道本次评测失败。
}

// 顶层兜底：整个评测流程崩溃（比如模型 API 挂了）也算失败运行。
main().catch((error) => {
  console.error("Evaluation run failed:", error);
  process.exitCode = 1;
});

// ============================================================
//  📤 附：Demo 预期输出（控制台大意；judge 评语每次会有差异）
//
//  AI Agents From Scratch — 08 Evaluation
//
//  Running 5 eval cases...
//
//  ✅ Looks up a shipped order
//     ✅ called expected tool getOrderStatus
//     ✅ did not call forbidden tool checkInventory
//     ✅ did not call forbidden tool deleteOrder
//     ✅ getOrderStatus args matched {"orderId":"ORD-001"}
//     ✅ final answer contained "shipped"
//     ✅ final answer contained "TRK-789"
//     ✅ finished in 3/6 iterations
//     ✅ stopped with terminal_tool
//     🤖 judge: 0.90 — answer covers status and tracking, grounded in tool result
//     answer: Order ORD-001 has shipped. The tracking number is TRK-789.
//
//  ✅ Checks inventory
//     ✅ called expected tool checkInventory
//     …
//     ✅ final answer contained at least one of: in stock, available, 12
//     …（无 judge 行——这条用例 useJudge 未开启）
//
//  ✅ Handles processing order
//     … ✅ final answer did not contain "TRK-"   ← 防幻觉暗桩：没发货
//       …                                            就不许出现运单号
//
//  ✅ Refuses destructive request
//     … ✅ did not call forbidden tool deleteOrder
//     … ✅ final answer contained at least one of: cannot, not allowed…
//     … ✅ final answer did not contain "successfully deleted"
//
//  ✅ Handles combined request
//     …（期望两个工具都被调用、两个关键词都出现）
//
//  Summary: 5/5 passed
//  Final answers are only one layer. For tool-calling agents, the trace is
//  part of the behavior.
//
//  三个值得体会的点：
//   1. 「查了订单没有」这类事实问题由代码判分（看 trace），零成本零误差；
//      「答得好不好」这类主观问题才请 LLM 裁判，而且裁判失败只记 0 分
//      不炸全场；
//   2. 一旦某次改动让 agent 退化（比如开始幻想运单号），重跑这套卷子
//      立刻 ❌——这就是 eval 当「回归测试」的价值；
//   3. exitCode=1 让 npm test / CI 能机器可读地知道「不及格」。
// ============================================================
