// ============================================================
//  第九章：multi-agent（多 Agent 协作）
//
//  学习目标：
//  1. 理解多 Agent 不是“多个模型聊天”，而是多个职责明确的步骤
//  2. 看懂 planner -> worker -> reviewer 的结构化交接
//  3. 学会把每个阶段的输出保存成可审计的 run artifact
//  4. 理解 reviewer 为什么应该独立检查 worker，而不是同一个 prompt 顺手自夸
//
//  核心结论：
//  多 Agent 系统的价值来自清晰分工和可验证交接，不来自角色数量本身。
// ============================================================

import "dotenv/config";

import { runPlannerAgent } from "./agents/plannerAgent.js";
import { runReviewerAgent } from "./agents/reviewerAgent.js";
import { runWorkerAgent } from "./agents/workerAgent.js";
import type { AgentStep, MultiAgentRunResult } from "./types.js";
import { prettyJson, printSection } from "./utils.js";

// The example goal. This is the single input that flows through every stage.
const USER_GOAL =
  "I want to build a small habit tracking app. Give me a practical MVP plan.";
// 整个流程只有一个原始用户目标。
// 后续每个 agent 都围绕这个目标处理不同阶段的工作。

async function main(): Promise<void> {
  console.log("AI Agents From Scratch — 09 Multi-Agent\n");

  const steps: AgentStep[] = [];
  // steps 是简短的运行摘要，记录每个 agent 做了什么。

  printSection("User goal");
  console.log(USER_GOAL);

  // 1. Planner: turn the goal into a structured plan.
  let plan: Awaited<ReturnType<typeof runPlannerAgent>>;
  // Awaited<ReturnType<...>> 可以从函数自动推导异步返回类型。
  // 这样 runPlannerAgent 的返回类型改了，这里也会同步更新。
  try {
    plan = await runPlannerAgent(USER_GOAL);
  } catch (error) {
    console.error({ stage: "planner", error: (error as Error).message });
    throw error;
  }
  steps.push({ agent: "planner", summary: plan.objective });
  printSection("Planner output");
  console.log(prettyJson(plan));

  // 2. Worker: build a grounded draft that stays within the plan.
  let draft: Awaited<ReturnType<typeof runWorkerAgent>>;
  // Worker 不直接读用户目标自由发挥，而是接收 planner 的结构化 plan。
  try {
    draft = await runWorkerAgent(USER_GOAL, plan);
  } catch (error) {
    console.error({ stage: "worker", error: (error as Error).message });
    throw error;
  }
  steps.push({ agent: "worker", summary: draft.product_scope });
  printSection("Worker draft");
  console.log(prettyJson(draft));

  // 3. Reviewer: check the draft against the goal and the plan.
  let review: Awaited<ReturnType<typeof runReviewerAgent>>;
  // Reviewer 接收 goal + plan + draft，专注检查是否满足要求。
  try {
    review = await runReviewerAgent(USER_GOAL, plan, draft);
  } catch (error) {
    console.error({ stage: "reviewer", error: (error as Error).message });
    throw error;
  }
  steps.push({
    agent: "reviewer",
    summary: review.final_recommendation,
  });
  printSection("Reviewer result");
  console.log(prettyJson(review));

  // 4. Final step: decide what to show based on the review.
  //    No recursive repair loop in v1 — we either approve the draft or hand
  //    back the draft together with the reviewer's feedback.
  printSection("Final answer");
  if (review.final_recommendation === "approve") {
    console.log("✅ Reviewer approved the draft. Final MVP plan:\n");
    console.log(prettyJson(draft));
  } else {
    console.log("⚠️  Reviewer asked for revisions. Returning draft + feedback.\n");
    console.log("Draft:");
    console.log(prettyJson(draft));
    console.log("\nReviewer feedback:");
    console.log(prettyJson(review));
  }

  // The whole run can be represented as one structured artifact: the goal plus
  // every stage's output. This is the object you would log, store, or evaluate.
  const result: MultiAgentRunResult = {
    // 这个 result 是完整运行产物。
    // 真实系统里可以把它存数据库，后续用于调试、回放或评测。
    goal: USER_GOAL,
    plan,
    draft,
    review,
    steps,
  };

  printSection("Handoffs");
  for (const step of result.steps) {
    console.log(`- ${step.agent}: ${step.summary}`);
  }

  console.log("\nFull run artifact (pass this to your eval harness):");
  console.log(prettyJson(result));

  console.log(
    "\nMulti-agent systems are not magic. They are structured handoffs: " +
      "planner → worker → reviewer → final answer."
  );
}

main().catch((error) => {
  console.error("Multi-agent run failed:", error);
  process.exitCode = 1;
});
