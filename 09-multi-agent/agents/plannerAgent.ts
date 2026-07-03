// ============================================================
//  Planner Agent：把模糊目标变成结构化计划
//
//  学习目标：
//  1. 让第一个 agent 只负责“理解需求和列计划”
//  2. 用 JSON 输出给后续 Worker 提供稳定输入
//  3. 避免 Planner 直接写最终答案或实现细节
// ============================================================

import "dotenv/config";

import { MAX_TOKENS, MODEL, TEMPERATURE, getClient } from "../config.js";
import { PlannerOutputSchema, type PlannerOutput } from "../types.js";
import { safeJsonParse } from "../utils.js";

// The Planner Agent has one job: turn a fuzzy user goal into a structured plan.
// It does not write the final answer and it does not implement anything. Its
// only output is the plan contract that the worker will build against.
const SYSTEM_PROMPT = `You are the Planner Agent.
Your job is to turn the user goal into a clear implementation plan.
Do not write the final answer.
Output only valid JSON.
No markdown.
No extra commentary.

Return a JSON object with exactly these fields:
{
  "objective": string,
  "user_type": string,
  "must_have_features": string[],
  "nice_to_have_features": string[],
  "technical_constraints": string[],
  "risks": string[],
  "acceptance_criteria": string[]
}`;

export async function runPlannerAgent(goal: string): Promise<PlannerOutput> {
  // Planner 的输入只有用户目标，输出必须符合 PlannerOutputSchema。
  // 这一步是把自然语言需求转换成工程化合同。
  const response = await getClient().chat.completions.create({
    model: MODEL,
    temperature: TEMPERATURE,
    max_tokens: MAX_TOKENS,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `User goal: ${goal}` },
    ],
  });

  const raw = response.choices[0].message.content ?? "";
  return safeJsonParse<PlannerOutput>(raw, "Planner Agent", PlannerOutputSchema);
}
