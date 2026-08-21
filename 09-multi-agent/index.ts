// ============================================================
//  第九章：multi-agent（多 Agent 协作——流水线总调度）
//
//  🏠 生活化比喻（接着前八章的故事讲）：
//  一个人的小作坊（前几章的单 agent）什么都能干，但任务一大
//  就容易「边写边自我感觉良好」。这一章改成三人小团队：
//    规划师 Planner  → 只理解需求、只出计划，不写答案
//    工匠 Worker     → 拿着计划 + 资料柜干活，产草稿
//    审稿人 Reviewer → 只对照原始需求和计划挑毛病，不重写
//  交接全部走「结构化合同」（Zod schema），口头转述不存在；
//  三个人的产出最终汇成一份完整的运行产物（run artifact），
//  可以直接交给第八章那样的评测系统。
//  v1 没有返工循环：审稿人说 revise，就把「草稿 + 审稿意见」
//  一起交出去，由人决定下一步——先看懂分工，再谈自动化。
//
//  学习目标：
//  1. 理解多 Agent 不是“多个模型聊天”，而是多个职责明确的步骤
//  2. 看懂 planner -> worker -> reviewer 的结构化交接
//  3. 学会把每个阶段的输出保存成可审计的 run artifact
//  4. 理解 reviewer 为什么应该独立检查 worker，而不是同一个 prompt 顺手自夸
//
//  核心结论：
//  多 Agent 系统的价值来自清晰分工和可验证交接，不来自角色数量本身。
//  三个守纪律的岗位，胜过一个什么都干的「全能选手」。
//
//  本模块文件导航：
//  - index.ts（本文件）：串联三个 agent 的流水线
//  - types.ts：三份交接合同（Zod schema）
//  - config.ts：模型配置 + 客户端懒加载
//  - utils.ts：验收口 safeJsonParse + 打印工具
//  - knowledge.ts：本地知识库（工匠的 grounding 来源）
//  - agents/plannerAgent.ts、workerAgent.ts、reviewerAgent.ts：三个岗位
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
  // 一句话概括谁干了啥——完整产物在最后，这里先记流水账。

  printSection("User goal");
  console.log(USER_GOAL);

  // ── 工序一：规划师 ────────────────────────────────────────
  // 1. Planner: turn the goal into a structured plan.
  // TS 语法：Awaited<ReturnType<typeof runPlannerAgent>> 是「从函数
  // 反推返回类型」的高级写法，拆开读：
  //   typeof runPlannerAgent   这个函数的类型
  //   ReturnType<…>            它的返回值类型（这里是 Promise<PlannerOutput>）
  //   Awaited<…>               把 Promise 拆包，拿到里面的 PlannerOutput
  // 为什么不直接写 PlannerOutput？因为这样「跟着函数走」——
  // 将来 runPlannerAgent 的返回类型改了，这里自动同步，不用两头改。
  let plan: Awaited<ReturnType<typeof runPlannerAgent>>;
  try {
    plan = await runPlannerAgent(USER_GOAL);
  } catch (error) {
    // 每道工序单独 try/catch：挂了就标明「哪道工序、什么错」再抛出，
    // 终端里一眼定位是规划师、工匠还是审稿人的锅。
    console.error({ stage: "planner", error: (error as Error).message });
    throw error;
  }
  steps.push({ agent: "planner", summary: plan.objective });
  printSection("Planner output");
  console.log(prettyJson(plan));

  // ── 工序二：工匠 ──────────────────────────────────────────
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

  // ── 工序三：审稿人 ────────────────────────────────────────
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

  // ── 收尾：按审稿意见分流 ──────────────────────────────────
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

  // 交接流水账：谁 → 干了什么，三行看完整个流程。
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

// 顶层兜底：任何工序抛错都会流到这里，exitCode=1 告诉脚本「这轮失败了」。
main().catch((error) => {
  console.error("Multi-agent run failed:", error);
  process.exitCode = 1;
});

// ============================================================
//  📤 附：Demo 预期输出（控制台大意；JSON 内容每次运行稳定
//     （temperature=0）但措辞仍可能有细微差异）
//
//  AI Agents From Scratch — 09 Multi-Agent
//
//  ─────
//  User goal
//  ─────
//  I want to build a small habit tracking app. Give me a practical MVP plan.
//
//  ─────
//  Planner output
//  ─────
//  {
//    "objective": "Build an MVP habit tracking app…",
//    "user_type": "individual users wanting to build daily habits",
//    "must_have_features": ["create habits", "daily check-in", "streak view", …],
//    "nice_to_have_features": ["reminders", "statistics", …],
//    "technical_constraints": ["single-user first", "offline-capable", …],
//    "risks": ["scope creep", "timezone bugs in streaks", …],
//    "acceptance_criteria": ["user can create a habit", …]
//  }
//
//  ─────
//  Worker draft
//  ─────
//  {
//    "product_scope": "A minimal single-user habit tracker…",
//    "data_model": ["User: id, email…", "Habit: …", "CheckIn: …"],
//    "api_endpoints": ["POST /habits", "GET /habits/:id/streak", …],
//    "frontend_screens": ["Today view", "Habit detail", …],
//    "development_sequence": ["1. schema + API", "2. today view", …],
//    "tradeoffs": ["SQLite for zero-setup", …]
//  }        ↑ 对照 knowledge.ts：工匠的建议明显「贴着资料柜」——
//             数据模型、接口示例都来自本地知识，这就是 grounding
//
//  ─────
//  Reviewer result
//  ─────
//  {
//    "final_recommendation": "approve",   ← 也可能是 "revise"
//    "missing_items": [],
//    "risky_claims": [],
//    "improvement_notes": ["consider adding auth earlier", …]
//  }
//
//  ─────
//  Final answer
//  ─────
//  ✅ Reviewer approved the draft. Final MVP plan: …（草稿再打一遍）
//
//  ─────
//  Handoffs
//  ─────
//  - planner: Build an MVP habit tracking app…
//  - worker: A minimal single-user habit tracker…
//  - reviewer: approve
//
//  Full run artifact (pass this to your eval harness): …（完整 JSON）
//
//  三个值得体会的点：
//   1. 三个 agent 各只调一次模型、各只干一件事——「多 agent」
//      的成本是多几次模型调用，收益是职责隔离和可检查的中间产物；
//   2. 每道工序的输出都是结构化 JSON 且经过 schema 验收——
//      任何一环格式坏了，整条流水线响亮地停在那道工序，而不是
//      把垃圾传到下游才出错；
//   3. revise 分支不会崩、不会偷偷重试：草稿 + 意见一起交出去，
//      「要不要返工」这个决策留给人——第 11 章会把
//      「等人工决定」做成一套完整的审批系统。
// ============================================================
