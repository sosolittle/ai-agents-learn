// ============================================================
//  第十章：routing（请求路由）
//
//  学习目标：
//  1. 理解 router agent 的职责是“选择路径”，不是直接执行任务
//  2. 学会把不同用户请求分到 direct/tool/research/multi-agent/approval/refuse
//  3. 理解为什么高风险或破坏性请求必须走人工审批或拒绝
//  4. 看懂 route decision 如何作为后续系统的输入和评测对象
//
//  核心结论：
//  路由不是为了显得更聪明，而是先选择最小、最安全、最便宜的执行路径。
// ============================================================

import "dotenv/config";

import { dispatch } from "./handlers.js";
import { runRouterAgent } from "./routerAgent.js";
import type { RoutedRequest } from "./types.js";
import { prettyJson, printSection } from "./utils.js";

// Six requests chosen so the reader sees a different route for each one. They go
// from the cheapest path (a plain explanation) to the one that must never run
// automatically (deleting production data).
const EXAMPLE_REQUESTS = [
  "Explain what an API is in simple terms.",
  "Check the delivery status of order ORD-001.",
  "Compare the latest pricing of two AI API providers.",
  "Create a practical MVP plan for a habit tracking app.",
  "Refund this customer and cancel their subscription.",
  "Delete all production users from the database.",
];
// 这些请求覆盖六种路线：普通回答、工具调用、研究、多 Agent、人工审批和拒绝。
// 读输出时可以观察 router 如何权衡成本和风险。

async function main(): Promise<void> {
  console.log("AI Agents From Scratch — 10 Routing\n");

  const results: RoutedRequest[] = [];
  // results 收集每个请求的路由决策和 mock handler 结果，
  // 最后统一打印 summary，方便对比。

  for (const request of EXAMPLE_REQUESTS) {
    printSection("User request");
    console.log(request);

    // 1. Route: the router agent classifies the request. This is the only model
    //    call in the loop — classification is cheap, execution is not.
    let decision: Awaited<ReturnType<typeof runRouterAgent>>;
    try {
      decision = await runRouterAgent(request);
    } catch (error) {
      console.error({ stage: "router", request, error: (error as Error).message });
      throw error;
    }

    printSection("Router decision");
    console.log(prettyJson(decision));

    // 2. Dispatch: hand the request to the mock handler for the chosen route.
    //    In a real system this is where the actual workflow would start.
    const handlerResult = dispatch(request, decision);
    // dispatch 是确定性代码，不是模型。
    // 模型只负责给出 decision；真正走哪条路径由代码根据 decision 执行。

    printSection("Handler result");
    console.log(`[${decision.route}] ${handlerResult}`);

    results.push({ request, decision, handlerResult });
  }

  // Every routing decision in one place: the object you would log, store, or
  // feed to an eval harness to check the router against expected routes.
  printSection("Routing summary");
  for (const { request, decision } of results) {
    console.log(
      `- ${decision.route.padEnd(14)} (${decision.risk_level}) ← ${request}`
    );
  }

  console.log(
    "\nRouting is not about making the system smarter. " +
      "It is about choosing the smallest safe path before any work runs."
  );
}

main().catch((error) => {
  console.error("Routing run failed:", error);
  process.exitCode = 1;
});
