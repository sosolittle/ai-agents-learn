// ============================================================
//  第十章 types：路由决策的数据合同
//
//  学习目标：
//  1. 用 enum 限制 route 只能是允许的六种路线
//  2. 用 schema 保证 confidence、risk_level 等字段形状稳定
//  3. 理解结构化路由结果为什么方便日志、审计和评测
// ============================================================

import { z } from "zod";

// The six execution paths a request can take. The router's only job is to pick
// one of these — it does not execute anything itself.
export const RouteNameSchema = z.enum([
  "direct_answer",
  "tool_use",
  "research",
  "multi_agent",
  "human_approval",
  "refuse",
]);

// The router's structured decision. This is a contract: every routing decision
// has the same shape, so it can be logged, evaluated, and audited.
export const RouterDecisionSchema = z.object({
  route: RouteNameSchema,
  confidence: z.number().min(0).max(1),
  reason: z.string(),
  risk_level: z.enum(["low", "medium", "high"]),
  required_capabilities: z.array(z.string()),
  next_step: z.string(),
});

export type RouteName = z.infer<typeof RouteNameSchema>;
export type RouterDecision = z.infer<typeof RouterDecisionSchema>;

// One request paired with the decision the router made about it. This is the
// object you would store or feed to an eval harness.
export interface RoutedRequest {
  // 一条请求的完整路由记录。
  // 真实系统里可以把它存下来，之后分析“哪些请求经常被拒绝/审批/研究”。
  request: string;
  decision: RouterDecision;
  handlerResult: string;
}
