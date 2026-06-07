import "dotenv/config";

import { runPlannerAgent } from "./agents/plannerAgent.js";
import { runReviewerAgent } from "./agents/reviewerAgent.js";
import { runWorkerAgent } from "./agents/workerAgent.js";
import type { AgentStep, MultiAgentRunResult } from "./types.js";
import { prettyJson, printSection } from "./utils.js";

// The example goal. This is the single input that flows through every stage.
const USER_GOAL =
  "I want to build a small habit tracking app. Give me a practical MVP plan.";

async function main(): Promise<void> {
  console.log("AI Agents From Scratch — 09 Multi-Agent\n");

  const steps: AgentStep[] = [];

  printSection("User goal");
  console.log(USER_GOAL);

  // 1. Planner: turn the goal into a structured plan.
  let plan: Awaited<ReturnType<typeof runPlannerAgent>>;
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
