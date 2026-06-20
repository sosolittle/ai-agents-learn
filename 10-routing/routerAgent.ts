import "dotenv/config";

import { MAX_TOKENS, MODEL, TEMPERATURE, getClient } from "./config.js";
import { RouterDecisionSchema, type RouterDecision } from "./types.js";
import { safeJsonParse } from "./utils.js";

// The Router Agent has one job: classify the request into one execution path.
// It does not answer, call tools, research, or run any workflow itself. Its
// only output is the routing decision the rest of the system acts on.
//
// The prompt is deliberately strict. The router should pick the *cheapest safe*
// path, not the most impressive one. "Sounds complex" is not a reason to route
// to multi-agent, and anything irreversible or destructive must not run
// automatically.
const SYSTEM_PROMPT = `You are the Router Agent.
Your only job is to classify the user request into exactly one execution route.
You do not answer the request. You do not call tools. You do not run any workflow.

Output only valid JSON.
No markdown.
No extra commentary.

Choose the cheapest safe route. Do not over-route.
Do not route to "multi_agent" just because the task sounds complex.
Use "human_approval" for irreversible, financial, account, production-data, or externally visible actions.
Use "refuse" for destructive or unsafe requests.
If a request matches both "human_approval" and "refuse", choose "refuse".
Destructive production-data actions must be refused, not approved.

Routes:
- "direct_answer": a simple explanation or general knowledge answer, no tools needed.
- "tool_use": needs one backend/system function call, like checking an order.
- "research": needs search, scraping, or gathering external/up-to-date sources.
- "multi_agent": needs planning, drafting, reviewing, or role separation.
- "human_approval": a risky/irreversible/high-impact action that should not run automatically.
- "refuse": an unsafe or unsupported request.

Return a JSON object with exactly these fields:
{
  "route": "direct_answer" | "tool_use" | "research" | "multi_agent" | "human_approval" | "refuse",
  "confidence": number between 0 and 1,
  "reason": string,
  "risk_level": "low" | "medium" | "high",
  "required_capabilities": string[],
  "next_step": string
}`;

export async function runRouterAgent(request: string): Promise<RouterDecision> {
  const response = await getClient().chat.completions.create({
    model: MODEL,
    temperature: TEMPERATURE,
    max_tokens: MAX_TOKENS,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `User request: ${request}` },
    ],
  });

  const raw = response.choices[0].message.content ?? "";
  return safeJsonParse<RouterDecision>(raw, "Router Agent", RouterDecisionSchema);
}
