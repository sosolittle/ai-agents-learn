// ============================================================
//  第十章 handlers：路由后的 mock 执行入口（六个科室的接待窗口）
//
//  🏠 生活化比喻：
//  分诊单开好了，病人走到对应科室的接待窗口。本章的重点是
//  「路由模式」而不是各科室的医术，所以六个窗口都只发一张
//  说明单（mock 字符串），不真治病。但窗口本身是认真搭的：
//  六条路线六个窗口，一个不缺；危险路线的窗口不是「治病慢」，
//  而是「先扣下单子等人来」或「直接不收」。
//
//  学习目标：
//  1. 理解 router decision 只是决策，handler 才是执行入口
//  2. 用每个 route 一个 handler 的方式表达系统边界
//  3. 观察高风险路线如何暂停或拒绝，而不是自动执行
// ============================================================

import type { RouteName, RouterDecision } from "./types.js";

// Mock handlers, one per route.
//
// This module is about the routing *pattern*, not production integrations, so
// none of these do real work. Each one just describes the path the request
// would take once routed. In a real system these would be the entry points to
// your actual subsystems: a tool layer, a research agent, a multi-agent
// workflow, an approval queue, and so on.

// TS 语法：Record<RouteName, (request: string) => string> 读作
// 「键是六种路线之一、值是『接请求返说明』函数」的字典。
// 类型系统的隐藏福利——穷尽性检查：RouteName 是封闭的六选一，
// 将来往 RouteNameSchema 里加第七条路线而忘了开窗口，
// 编译器立刻报错「缺 key」。字典从「靠自觉填全」变成「漏了就编译失败」。
const handlers: Record<RouteName, (request: string) => string> = {
  // 如果将来 RouteNameSchema 新增路线，这里漏写时 TypeScript 会提醒。
  // Cheapest path: just answer. No tools, no side effects.
  direct_answer: () =>
    "Answered directly with a short explanation. No tools or side effects.",

  // One backend call. Here we pretend to look up an order.
  tool_use: (request) => {
    // 从请求文本里抠出订单号，抠不出就用兜底值。
    // TS 语法拆解 request.match(/ORD-\d+/i)?.[0] ?? "ORD-001"：
    //   /ORD-\d+/i  正则：ORD- 后跟数字（\d+），i 不分大小写
    //   .match(…)   命中返回类数组（[0] 是整段匹配），不命中返回 null
    //   ?. [0]      可选链：null 时短路成 undefined，不报错
    //   ?? "ORD-001" 空值合并：undefined 时用兜底单号
    // 一行完成「提取 → 容错 → 兜底」三步，读熟这种链式写法很有用。
    const order = request.match(/ORD-\d+/i)?.[0] ?? "ORD-001";
    return `Called getOrderStatus("${order}") → { status: "in_transit", eta: "2 days" } (mock).`;
  },

  // Hand off to a search/scraping/research agent for external sources.
  research: () =>
    "Handed off to the research agent (web search + source gathering). Not run here.",

  // Hand off to the planner → worker → reviewer flow from module 09.
  multi_agent: () =>
    "Handed off to the multi-agent workflow: planner → worker → reviewer. Not run here.",

  // Risky/irreversible action: do not run automatically. Pause for a human.
  // 高风险动作的窗口只做一件事：把单子挂起，等人工审批。
  // 注意它不是「执行得慢一点」，而是「根本不执行」——
  // 第 11 章会把这套「挂起 + 审批」做成带持久化的真系统。
  human_approval: () =>
    "Action paused. Queued for human approval before anything executes.",

  // Unsafe/unsupported: refuse and explain why.
  refuse: () =>
    "Request blocked. This action is unsafe or unsupported and will not be executed.",
};

/** Dispatch a routed request to its mock handler. */
export function dispatch(request: string, decision: RouterDecision): string {
  // dispatch 根据 router 的结构化结果选择 handler。
  // 这里是 mock 字符串；真实系统里会启动对应子系统。
  //
  // 关键理解：这一行是「确定性代码」，不是模型。路由的「决策」
  // 由模型给出，但「按决策走哪条路」由代码执行——
  // 模型无权越过 dispatch 直接调 handler（同第五站 allowlist 的思路：
  // 提示词引导行为，代码执法底线）。
  return handlers[decision.route](request);
}
