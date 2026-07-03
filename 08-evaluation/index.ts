// ============================================================
//  第八章入口：运行一组 eval cases
//
//  学习目标：
//  1. 理解评测不是只看“回答像不像”，还要检查工具调用轨迹
//  2. 学会把 agent 输出交给 deterministic evaluator 和可选 LLM judge
//  3. 看懂如何用 process.exitCode 让失败评测影响命令退出状态
// ============================================================

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
    const result = await runAgent(testCase.input);
    const report = evaluateCase(testCase, result);
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
    const passed = report.passed && (judge?.passed ?? true);
    if (passed) passedCount++;

    console.log(`${icon(passed)} ${testCase.name}`);
    for (const check of report.checks) {
      console.log(`   ${icon(check.passed)} ${check.message}`);
    }
    if (judge) {
      console.log(`   🤖 judge: ${judge.score.toFixed(2)} — ${judge.reasoning}`);
    }
    console.log(`   answer: ${report.finalAnswer || "(none)"}\n`);
  }

  console.log(`Summary: ${passedCount}/${evalCases.length} passed`);
  console.log(
    "Final answers are only one layer. For tool-calling agents, the trace is part of the behavior."
  );

  if (passedCount !== evalCases.length) process.exitCode = 1;
  // 设置 exitCode=1 后，CI 或脚本可以知道本次评测失败。
}

main().catch((error) => {
  console.error("Evaluation run failed:", error);
  process.exitCode = 1;
});
