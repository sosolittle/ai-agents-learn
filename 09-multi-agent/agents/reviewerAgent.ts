// ============================================================
//  Reviewer Agent：独立审查 Worker 草稿（审稿人）
//
//  🏠 生活化比喻：
//  审稿人拿到三份材料：用户原话、计划书、工匠的草稿。
//  他的纪律：「只挑毛病，不重写」。为什么生成和审查要分给
//  两个人？因为自己检查自己的作业，天然会「手下留情」——
//  同一个 prompt 里既让模型写方案又让它自评，它多半顺着
//  夸自己。独立的审稿人没有辩护动机，才能下狠手。
//  他的最终意见只有两个词：approve（过）或 revise（打回），
//  主流程据此分流，不用猜。
//
//  学习目标：
//  1. 理解“生成”和“审查”分离为什么能提升质量
//  2. 用原始 goal、plan、draft 三份材料进行对照检查
//  3. 通过 approve/revise 给主流程一个明确决策信号
// ============================================================

import "dotenv/config";

import { MAX_TOKENS, MODEL, TEMPERATURE, getClient } from "../config.js";
import { ReviewResultSchema, type PlannerOutput, type ReviewResult, type WorkerDraft } from "../types.js";
import { prettyJson, safeJsonParse } from "../utils.js";

// The Reviewer Agent checks the worker draft against the goal and the plan. It
// does not write the final answer either — it only judges. Separating "produce"
// from "check" is the whole point: the reviewer can be stricter because it has
// no incentive to defend the draft.
const SYSTEM_PROMPT = `You are the Reviewer Agent.
Your job is to check the worker draft against the user goal and planner output.
You are not writing the final answer.
Check for missing requirements, unsupported claims, scope creep, and vague recommendations.
Output only valid JSON.
No markdown.
No extra commentary.

Return a JSON object with exactly these fields:
{
  "missing_items": string[],
  "risky_claims": string[],
  "improvement_notes": string[],
  "final_recommendation": "approve" | "revise"
}
Default to revise unless every acceptance criterion in the plan is explicitly satisfied by the draft.`;
// ↑ 最后一句是审稿人的「严格标准」：默认打回，除非计划里的
// 验收标准被草稿逐条明确满足。宁可错杀（多打回一次），
// 不可放过（带病出厂）——和第五章 allowlist 的默认拒绝同款思路。

export async function runReviewerAgent(
  goal: string,
  plan: PlannerOutput,
  draft: WorkerDraft
): Promise<ReviewResult> {
  // Reviewer 不需要调用工具，只需要检查一致性：
  // draft 是否满足 goal 和 plan，是否有缺项、风险或范围蔓延。
  // 三份材料分三段拼进 userContent，各自标明身份
  // （「计划 = 草稿应当满足的标准」「草稿 = 被审对象」），
  // 让模型清楚「谁对照谁」。
  const userContent = [
    `Original user goal: ${goal}`,
    "",
    "Planner output (the plan the draft should satisfy):",
    prettyJson(plan),
    "",
    "Worker draft (the thing you are reviewing):",
    prettyJson(draft),
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
  // 验收口：审稿意见本身也是机器要消费的数据（主流程看
  // final_recommendation 分流），所以同样要过 schema——
  // 比如模型自作主张写了 "approved"，z.enum 当场拒收。
  return safeJsonParse<ReviewResult>(raw, "Reviewer Agent", ReviewResultSchema);
}
