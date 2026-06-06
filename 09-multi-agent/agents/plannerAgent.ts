import "dotenv/config";
import OpenAI from "openai";

import type { PlannerOutput } from "../types.js";
import { safeJsonParse } from "../utils.js";

const MODEL = "gpt-4o-mini";
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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
  const response = await client.chat.completions.create({
    model: MODEL,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `User goal: ${goal}` },
    ],
  });

  const raw = response.choices[0].message.content ?? "";
  return safeJsonParse<PlannerOutput>(raw, "Planner Agent");
}
