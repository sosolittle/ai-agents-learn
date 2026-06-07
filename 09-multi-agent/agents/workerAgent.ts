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
  return safeJsonParse<WorkerDraft>(raw, "Worker Agent", WorkerDraftSchema);
}
