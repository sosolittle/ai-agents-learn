// ============================================================
//  Action Proposal Agent：只描述“做什么”，不决定“能不能做”
//
//  学习目标：
//  1. 把模型职责限制为选择工具和生成参数
//  2. 用严格 JSON Schema 阻止模型夹带授权字段
//  3. 理解 prompt 约束用于引导输出，Zod 校验才是程序边界
// ============================================================

import "dotenv/config";

import { MAX_TOKENS, MODEL, TEMPERATURE, getClient } from "./config.js";
import { ActionProposalSchema, type ActionProposal } from "./types.js";
import { safeJsonParse } from "./utils.js";

// The Action Proposal Agent has one job: read the request and propose which
// supported tool could satisfy it and with what arguments. That is capability.
//
// It deliberately has NO say over permission. The prompt forbids any field like
// requiresApproval, isAuthorized, or allowed — and the schema's `.strict()`
// objects would reject them anyway. Whether the proposed action may run is
// decided later, by the deterministic policy layer, not by the model.
const SYSTEM_PROMPT = `You are the Action Proposal Agent for a customer-support system.

Your only job is to propose ONE supported tool call that could satisfy the user's request,
and the arguments for it. You describe capability, not permission.

You do NOT decide any of the following:
- whether the action is authorized
- whether it requires approval
- whether it is allowed
- whether it should execute automatically

Never include fields like "requiresApproval", "isAuthorized", "allowed", or "autoExecute".
The application decides those. You only propose the tool and arguments.

Output only valid JSON. No markdown. No commentary.

Supported tools and their arguments:
- "getOrderStatus": { "orderId": string like "ORD-001" }
- "refundOrder": { "orderId": string like "ORD-001", "amount": number > 0, "currency": "EUR", "reason": string }
- "cancelSubscription": { "customerId": string like "CUS-104", "reason": string }
- "deleteProductionUsers": {}

Return a JSON object with exactly these fields:
{
  "toolName": one of the supported tool names,
  "arguments": the arguments object for that tool,
  "reason": a short explanation of why you selected this tool
}`;

export async function proposeAction(request: string): Promise<ActionProposal> {
  // 本章节唯一一次模型调用发生在这里。后续 policy、审批状态迁移和执行
  // 全部由普通 TypeScript 代码完成，因此它们可重复、可测试、可审计。
  const response = await getClient().chat.completions.create({
    model: MODEL,
    temperature: TEMPERATURE,
    max_tokens: MAX_TOKENS,
    response_format: { type: "json_object" },
    messages: [
      // system 定义角色边界；user 只携带当前业务请求，避免把权限逻辑
      // 动态拼进用户消息后交给模型自行判断。
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `User request: ${request}` },
    ],
  });

  const raw = response.choices[0].message.content ?? "";
  // response_format 只能提高返回 JSON 的概率；它不能替代业务校验。
  // safeJsonParse 会先解析 JSON，再用 ActionProposalSchema 检查工具和参数。
  return safeJsonParse<ActionProposal>(
    raw,
    "Action Proposal Agent",
    ActionProposalSchema
  );
}
