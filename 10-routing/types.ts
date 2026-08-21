// ============================================================
//  第十章 types：路由决策的数据合同
//
//  🏠 生活化比喻：
//  医院分诊台的「分诊单」模板：科室（route，六个选项之一）、
//  把握度（confidence）、理由（reason）、风险等级（risk_level）、
//  需要的能力（required_capabilities）、下一步（next_step）。
//  每张分诊单形状完全一致——所以能被统一记录、统计、审计，
//  也能当评测对象（「这 20 条历史请求，分诊都分对了吗？」）。
//
//  学习目标：
//  1. 用 enum 限制 route 只能是允许的六种路线
//  2. 用 schema 保证 confidence、risk_level 等字段形状稳定
//  3. 理解结构化路由结果为什么方便日志、审计和评测
// ============================================================

import { z } from "zod";

// The six execution paths a request can take. The router's only job is to pick
// one of these — it does not execute anything itself.
// z.enum 一箭双雕：
//   运行时——白名单校验，模型写出 "human-approval" 这种自创拼法当场拒收；
//   编译时——（配 z.infer）得到六选一的联合类型。
// 顺带一提，六条路线正好对应本仓库已学的六种能力：
//   direct_answer（01 章）、tool_use（02 章）、research（04/05 章）、
//   multi_agent（09 章）、human_approval（11 章）、refuse（直接说不行）。
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
  // z.number().min(0).max(1) —— 链式约束：数字，且必须落在 [0, 1]。
  // 每接一个方法就多一层运行时检查，像流水线上的多道质检。
  confidence: z.number().min(0).max(1),
  reason: z.string(),
  risk_level: z.enum(["low", "medium", "high"]),
  required_capabilities: z.array(z.string()),
  next_step: z.string(),
});

// 从 schema 反推类型（Zod 标准三板斧：定义 schema → infer 类型 →
// 运行时 safeParse / 编译时用类型，见第九章 types.ts 的讲解）。
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
