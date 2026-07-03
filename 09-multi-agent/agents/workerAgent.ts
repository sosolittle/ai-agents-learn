// ============================================================
//  Worker Agent：根据计划和知识库产出 MVP 草稿
//
//  学习目标：
//  1. 理解 Worker 不应该重新解释用户目标，而应该服从 Planner 的计划
//  2. 学会把 local knowledge 注入 prompt，让输出更 grounded
//  3. 用 schema 校验 Worker 草稿，保证 Reviewer 能稳定读取
// ============================================================

import "dotenv/config";

import { MAX_TOKENS, MODEL, TEMPERATURE, getClient } from "../config.js";
import { knowledge } from "../knowledge.js";
import { WorkerDraftSchema, type PlannerOutput, type WorkerDraft } from "../types.js";
import { prettyJson, safeJsonParse } from "../utils.js";

// The Worker Agent receives the plan plus local knowledge and produces a
// grounded MVP draft. It is told to stay within the plan and prefer practical
// detail over invented architecture. The knowledge base is what keeps it from
// making everything up.
const SYSTEM_PROMPT = `You are the Worker Agent.
Your job is to produce a grounded MVP draft from the plan and knowledge.
Stay within the plan.
Prefer practical implementation details.
Output only valid JSON.
No markdown.
No extra commentary.

Return a JSON object with exactly these fields:
{
  "product_scope": string,
  "data_model": string[],
  "api_endpoints": string[],
  "frontend_screens": string[],
  "development_sequence": string[],
  "tradeoffs": string[]
}`;

export async function runWorkerAgent(
  goal: string,
  plan: PlannerOutput
): Promise<WorkerDraft> {
  // Worker 接收原始 goal 和 plan。
  // goal 用于避免计划丢失原始意图；plan 用于约束工作范围。
  const userContent = [
    `Original user goal: ${goal}`,
    "",
    "Planner output (the plan you must stay within):",
    prettyJson(plan),
    "",
    "Local engineering knowledge (JSON):",
    JSON.stringify(knowledge, null, 2),
  ].join("\n");

  const response = await getClient().chat.completions.create({
    model: MODEL,
    temperature: TEMPERATURE,
    max_tokens: MAX_TOKENS,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userContent },
    ],
  });

  const raw = response.choices[0].message.content ?? "";
  // 这里不直接 return JSON.parse(raw)，而是交给 safeJsonParse 做 schema 校验。
  return safeJsonParse<WorkerDraft>(raw, "Worker Agent", WorkerDraftSchema);
}
