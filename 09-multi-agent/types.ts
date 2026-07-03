// ============================================================
//  第九章 types：多 Agent 之间的交接合同
//
//  学习目标：
//  1. 用 Zod 同时提供运行时校验和 TypeScript 类型
//  2. 明确 planner、worker、reviewer 每一步必须返回哪些字段
//  3. 理解结构化 handoff 比自然语言 handoff 更容易调试和评测
// ============================================================

import { z } from "zod";

export const PlannerOutputSchema = z.object({
  objective: z.string(),
  user_type: z.string(),
  must_have_features: z.array(z.string()),
  nice_to_have_features: z.array(z.string()),
  technical_constraints: z.array(z.string()),
  risks: z.array(z.string()),
  acceptance_criteria: z.array(z.string()),
});
// Planner 的输出是 Worker 的输入合同。
// 如果 Planner 少返回字段，safeJsonParse 会在边界处立刻失败。

export const WorkerDraftSchema = z.object({
  product_scope: z.string(),
  data_model: z.array(z.string()),
  api_endpoints: z.array(z.string()),
  frontend_screens: z.array(z.string()),
  development_sequence: z.array(z.string()),
  tradeoffs: z.array(z.string()),
});
// WorkerDraft 是最终 MVP 方案草稿，包含产品范围、数据模型、接口和开发顺序。

export const ReviewResultSchema = z.object({
  final_recommendation: z.enum(["approve", "revise"]),
  missing_items: z.array(z.string()),
  risky_claims: z.array(z.string()),
  improvement_notes: z.array(z.string()),
});
// Reviewer 不写新方案，只指出问题并给 approve/revise 建议。

export type PlannerOutput = z.infer<typeof PlannerOutputSchema>;
export type WorkerDraft = z.infer<typeof WorkerDraftSchema>;
export type ReviewResult = z.infer<typeof ReviewResultSchema>;

export interface AgentStep {
  agent: "planner" | "worker" | "reviewer";
  summary: string;
}

export interface MultiAgentRunResult {
  // 完整运行产物：把 goal、三个阶段输出和简要步骤串起来。
  // 这是后续日志、评测、回放最方便的数据结构。
  goal: string;
  plan: PlannerOutput;
  draft: WorkerDraft;
  review: ReviewResult;
  steps: AgentStep[];
}
