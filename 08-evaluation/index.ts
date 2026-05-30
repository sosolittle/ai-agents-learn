import { runAgent } from "./agent.js";
import { evalCases } from "./eval-cases.js";
import { evaluateCase } from "./evaluator.js";
import { judgeAnswer } from "./judge.js";

function icon(passed: boolean): string {
  return passed ? "✅" : "❌";
}

async function main(): Promise<void> {
  console.log("AI Agents From Scratch — 08 Evaluation\n");
  console.log(`Running ${evalCases.length} eval cases...\n`);

  let passedCount = 0;
  for (const testCase of evalCases) {
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
}

main().catch((error) => {
  console.error("Evaluation run failed:", error);
  process.exitCode = 1;
});
