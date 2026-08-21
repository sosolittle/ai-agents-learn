// ============================================================
//  第九章 types：多 Agent 之间的交接合同（Zod 初登场）
//
//  🏠 生活化比喻：
//  三个 agent 像三个岗位的员工：规划师出计划、工匠照着做、
//  审稿人挑毛病。他们交接工作时不用「口头转述」（自然语言
//  自由发挥），而是签三份格式合同（schema）——每份合同写明
//  「必须有哪些字段、各是什么形状」。谁交的货缺一章少一节，
//  在验收口（utils.ts 的 safeJsonParse）当场报废重来，
//  绝不带病流入下一道工序。
//
//  为什么用 Zod（本仓库 08–12 章的标配）：
//  TS 的 interface 只在编译时存在，管不住模型运行时吐出的 JSON。
//  Zod 的 schema 是「运行时真的会跑的检查代码」；再用 z.infer
//  从同一份 schema 反推出 TS 类型——写一次，编译期和运行期双保险。
//
//  学习目标：
//  1. 用 Zod 同时提供运行时校验和 TypeScript 类型
//  2. 明确 planner、worker、reviewer 每一步必须返回哪些字段
//  3. 理解结构化 handoff 比自然语言 handoff 更容易调试和评测
// ============================================================

import { z } from "zod";

// ── 合同一：规划师的产出 ─────────────────────────────────────
// z.object({...}) = 「必须是一个对象，且有这些字段」。
// z.string() = 该字段必须是字符串；z.array(z.string()) = 字符串数组。
// 这些不是类型注解——是真的会在运行时逐字段检查的代码。
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

// ── 合同二：工匠的草稿 ──────────────────────────────────────
export const WorkerDraftSchema = z.object({
  product_scope: z.string(),
  data_model: z.array(z.string()),
  api_endpoints: z.array(z.string()),
  frontend_screens: z.array(z.string()),
  development_sequence: z.array(z.string()),
  tradeoffs: z.array(z.string()),
});
// WorkerDraft 是最终 MVP 方案草稿，包含产品范围、数据模型、接口和开发顺序。

// ── 合同三：审稿人的审稿意见 ────────────────────────────────
export const ReviewResultSchema = z.object({
  // z.enum([...]) = 只允许列出的这几个词（本系列的字符串字面量联合
  // 升级成了运行时也检查的白名单）——审稿人只能「通过」或「打回」，
  // 没有第三种说法，主流程才好据此分流。
  final_recommendation: z.enum(["approve", "revise"]),
  missing_items: z.array(z.string()),
  risky_claims: z.array(z.string()),
  improvement_notes: z.array(z.string()),
});
// Reviewer 不写新方案，只指出问题并给 approve/revise 建议。

// TS 语法：z.infer<typeof X> = 「从 schema 反推出对应的 TS 类型」。
// 一份 schema 两个用途：运行时 safeParse 校验数据（真跑），
// 编译时 infer 出类型给代码标注（免费附赠）。
// 以后改合同只改 schema 一处，类型自动跟着变——单一事实来源。
export type PlannerOutput = z.infer<typeof PlannerOutputSchema>;
export type WorkerDraft = z.infer<typeof WorkerDraftSchema>;
export type ReviewResult = z.infer<typeof ReviewResultSchema>;

// 运行摘要里的「谁」：三个岗位名的字面量联合。
export interface AgentStep {
  agent: "planner" | "worker" | "reviewer";
  summary: string;
}

export interface MultiAgentRunResult {
  // 完整运行产物：把 goal、三个阶段输出和简要步骤串起来。
  // 这是后续日志、评测、回放最方便的数据结构。
  // （对应第八章的思路：要可评测，先要把运行变成一个结构化对象。）
  goal: string;
  plan: PlannerOutput;
  draft: WorkerDraft;
  review: ReviewResult;
  steps: AgentStep[];
}
