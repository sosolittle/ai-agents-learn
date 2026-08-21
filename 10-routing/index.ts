// ============================================================
//  第十章：routing（请求路由——分诊台总览）
//
//  🏠 生活化比喻（接着前九章的故事讲）：
//  到现在为止的系统有个隐藏假设：来的每件事都用同一套流程处理。
//  但现实里，「解释一下什么是 API」和「删掉生产库全部用户」
//  显然不该走同一条路。所以在最前面加一个分诊台：
//  分诊护士（router agent）只做一件事——判断该挂哪个科，
//  然后交给对应科室（handler）。六条路线按成本和风险排开：
//    direct_answer  最便宜：直接回答（01 章）
//    tool_use       一次函数调用（02 章）
//    research       联网搜资料（04/05 章）
//    multi_agent    多岗位流水线（09 章）
//    human_approval 高风险：挂起等人批（11 章做成真系统）
//    refuse         纯破坏性：直接拒绝
//  分诊纪律：能便宜就便宜；危险的不许自动执行。
//
//  学习目标：
//  1. 理解 router agent 的职责是“选择路径”，不是直接执行任务
//  2. 学会把不同用户请求分到 direct/tool/research/multi-agent/approval/refuse
//  3. 理解为什么高风险或破坏性请求必须走人工审批或拒绝
//  4. 看懂 route decision 如何作为后续系统的输入和评测对象
//
//  核心结论：
//  路由不是为了显得更聪明，而是先选择最小、最安全、最便宜的执行路径。
//  分类一次模型调用的钱，换执行阶段不花冤枉钱、不冒不该冒的险。
//
//  本模块文件导航：
//  - index.ts（本文件）：六条示例请求走完整路由流程
//  - routerAgent.ts：分诊护士（结构化决策 + Zod 验收）
//  - handlers.ts：六条路线的 mock 接待窗口 + dispatch
//  - types.ts：路线枚举 + 决策合同
//  - config.ts / utils.ts：配置与共用工具
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
  "Explain what an API is in simple terms.",      // → direct_answer
  "Check the delivery status of order ORD-001.",  // → tool_use
  "Compare the latest pricing of two AI API providers.", // → research（要联网比价）
  "Create a practical MVP plan for a habit tracking app.", // → multi_agent（要规划）
  "Refund this customer and cancel their subscription.",  // → human_approval（动钱）
  "Delete all production users from the database.",       // → refuse（纯破坏）
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
    // 每条请求一次（也仅一次）模型调用：分诊。真正昂贵的执行
    // 都被 mock 掉了，所以整个 demo 的 token 花销极小。
    let decision: Awaited<ReturnType<typeof runRouterAgent>>;
    try {
      decision = await runRouterAgent(request);
    } catch (error) {
      // 路由失败（输出不合合同等）→ 打标抛出，整个 demo 终止。
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
  // TS 语法：for-of 的解构赋值——const { request, decision } of results
  // 每轮把一个元素的 request/decision 两个字段直接拆进两个变量，
  // 不用写 r.request / r.decision。
  for (const { request, decision } of results) {
    console.log(
      // padEnd(14)：把路线名补齐到 14 个字符宽——短名后面补空格，
      // 六行路线就能对成一列。控制台表格全靠这种小技巧。
      `- ${decision.route.padEnd(14)} (${decision.risk_level}) ← ${request}`
    );
  }

  console.log(
    "\nRouting is not about making the system smarter. " +
      "It is about choosing the smallest safe path before any work runs."
  );
}

// 顶层兜底：任何一环抛错都到这里，exitCode=1（同前几章）。
main().catch((error) => {
  console.error("Routing run failed:", error);
  process.exitCode = 1;
});

// ============================================================
//  📤 附：Demo 预期输出（Routing summary 部分，控制台大意）
//
//  ─────
//  Routing summary
//  ─────
//  - direct_answer  (low)    ← Explain what an API is in simple terms.
//  - tool_use       (low)    ← Check the delivery status of order ORD-001.
//  - research       (medium) ← Compare the latest pricing of two AI API providers.
//  - multi_agent    (medium) ← Create a practical MVP plan for a habit tracking app.
//  - human_approval (high)   ← Refund this customer and cancel their subscription.
//  - refuse         (high)   ← Delete all production users from the database.
//
//  （每条请求前面还有三段：User request / Router decision（完整 JSON，
//    含 confidence、reason、next_step）/ Handler result（mock 说明单））
//
//  四个值得体会的点：
//   1. 成本单调上升：从「直接说话」到「多 agent 流水线」，
//      路由在便宜的那一层就把问题解决掉；
//   2. 风险与成本对齐：贵的路线同时也是高风险的——
//      动钱、动生产数据的动作被拦在「人工审批」或「拒绝」，
//      绝不自动执行；
//   3. 六条路线是封闭集合（z.enum）：不存在「路由到第七种
//      意外路线」这种事故；模型自创路线名会在验收口报废；
//   4. decision 是结构化数据——把这次的 results 存下来，
//      就能用第八章的思路给路由本身出考卷
//     （「这 20 条请求，分诊都分对了吗？」）。
// ============================================================
