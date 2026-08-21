// ============================================================
//  Worker Agent：根据计划和知识库产出 MVP 草稿（工匠）
//
//  🏠 生活化比喻：
//  工匠动工时手里有两样东西：规划师的计划书（plan）和
//  资料柜（knowledge）。他的纪律是「在计划范围内干活」——
//  不重新解释用户想要什么（那是规划师的事），不自由发挥
//  架构（资料柜里有推荐）。产出的草稿同样要走验收口，
//  保证审稿人拿到的是结构完整的货。
//
//  学习目标：
//  1. 理解 Worker 不应该重新解释用户目标，而应该服从 Planner 的计划
//  2. 学会把 local knowledge 注入 prompt，让输出更 grounded
//  3. 用 schema 校验 Worker 草稿，保证 Reviewer 能稳定读取
// ============================================================

import "dotenv/config";

import { MAX_TOKENS, MODEL, TEMPERATURE, getClient } from "../config.js";
import { knowledge } from "../knowledge.js";
// 一行 import 里同时拿类型（type PlannerOutput）和值（schema）——
// Zod 的常见姿势：schema 运行时校验用，类型编译时标注用。
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
  //
  // userContent 三段拼装（数组 + join 的文本拼装套路，见 knowledge.ts）：
  //   ① 原始目标——给工匠「不忘初心」的锚点；
  //   ② 计划书 JSON——带缩进的可读格式（prettyJson），
  //      并明说「你必须在它范围内工作」；
  //   ③ 资料柜 JSON——本地的工程知识，工匠的 grounding 来源。
  // 三段缺一不可：只给 plan 会丢用户原话，只给 goal 会自由发挥，
  // 没有 knowledge 就只剩模型的通用记忆。
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
  // 草稿少字段（比如漏了 tradeoffs）会带着「Worker Agent returned
  // invalid shape」的完整诊断抛出——主流程接住并终止，不带病进审稿。
  return safeJsonParse<WorkerDraft>(raw, "Worker Agent", WorkerDraftSchema);
}
