// ============================================================
//  第十章 Router Agent：把用户请求分类到执行路线（分诊护士）
//
//  🏠 生活化比喻：
//  分诊护士不治病——量个体温、问两句话，然后告诉你挂哪个科。
//  她的「分诊纪律」全写在 SYSTEM_PROMPT 里，三条最要紧：
//   ① 能便宜就便宜（cheapest safe）：说句话就能答的，
//      别兴师动众开多 agent 会诊；
//   ② 「听起来复杂」不是升级理由——不许因为任务听起来
//      复杂就路由到 multi_agent；
//   ③ 危险动作拦下：不可逆的（退款/删数据）转人工审批，
//      纯破坏性的（删生产库）直接拒绝；两头都沾时按拒绝算。
//  她的输出是一张结构化分诊单（JSON），不是治疗本身。
//
//  学习目标：
//  1. 理解 router 不回答问题，只输出结构化决策
//  2. 用严格 prompt 约束“选择最便宜安全路线”
//  3. 用 Zod 校验 route/confidence/risk_level 等字段
// ============================================================

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
// 提示词里两条值得划重点的硬规则：
//  「both → refuse」：同样沾边人工审批和拒绝时按拒绝算——
//   没有哪个审批人应该被叫来批准「删光生产用户表」这种事；
//  「Do not over-route」：不许因为「听起来复杂」就升级到
//   multi_agent——贵的能力要用在真需要的地方。

export async function runRouterAgent(request: string): Promise<RouterDecision> {
  // 输入是一条用户请求，输出是 RouterDecision。
  // 后续 dispatch 会根据 decision.route 选择对应处理器。
  //
  // 注意这是一次「无工具的纯分类调用」——没有 tools 数组、
  // 没有循环。分类这种事一次调用就该做完；真正贵的执行
  //（研究、多 agent）发生在路由之后、且只发生在该发生的地方。
  // 「分类便宜、执行昂贵，先用便宜的一步决定贵的怎么走」
  // 正是路由模式的经济账。
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
  // 验收口：分诊单必须完全符合模板。route 拼错、confidence
  // 超出 [0,1]、risk_level 自创等级——都在这里当场报废。
  return safeJsonParse<RouterDecision>(raw, "Router Agent", RouterDecisionSchema);
}
