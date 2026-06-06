import "dotenv/config";
import OpenAI from "openai";

import type { PlannerOutput, ReviewResult, WorkerDraft } from "../types.js";
import { prettyJson, safeJsonParse } from "../utils.js";

const MODEL = "gpt-4o-mini";
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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
  "passed": boolean,
  "missing_items": string[],
  "risky_claims": string[],
  "improvement_notes": string[],
  "final_recommendation": "approve" | "revise"
}`;

export async function runReviewerAgent(
  goal: string,
  plan: PlannerOutput,
  draft: WorkerDraft
): Promise<ReviewResult> {
  const userContent = [
    `Original user goal: ${goal}`,
    "",
    "Planner output (the plan the draft should satisfy):",
    prettyJson(plan),
    "",
    "Worker draft (the thing you are reviewing):",
    prettyJson(draft),
  ].join("\n");

  const response = await client.chat.completions.create({
    model: MODEL,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userContent },
    ],
  });

  const raw = response.choices[0].message.content ?? "";
  return safeJsonParse<ReviewResult>(raw, "Reviewer Agent");
}
