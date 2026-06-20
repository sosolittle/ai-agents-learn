import type { RouteName, RouterDecision } from "./types.js";

// Mock handlers, one per route.
//
// This module is about the routing *pattern*, not production integrations, so
// none of these do real work. Each one just describes the path the request
// would take once routed. In a real system these would be the entry points to
// your actual subsystems: a tool layer, a research agent, a multi-agent
// workflow, an approval queue, and so on.

const handlers: Record<RouteName, (request: string) => string> = {
  // Cheapest path: just answer. No tools, no side effects.
  direct_answer: () =>
    "Answered directly with a short explanation. No tools or side effects.",

  // One backend call. Here we pretend to look up an order.
  tool_use: (request) => {
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
  human_approval: () =>
    "Action paused. Queued for human approval before anything executes.",

  // Unsafe/unsupported: refuse and explain why.
  refuse: () =>
    "Request blocked. This action is unsafe or unsupported and will not be executed.",
};

/** Dispatch a routed request to its mock handler. */
export function dispatch(request: string, decision: RouterDecision): string {
  return handlers[decision.route](request);
}
