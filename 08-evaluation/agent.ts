// ============================================================
//  第八章 agent：可评测的工具调用 agent
//
//  学习目标：
//  1. 理解为了评测，agent 需要返回结构化结果，而不只是打印文本
//  2. 学会把 finalAnswer、stopReason、iterations 和 trace 一起返回
//  3. 看懂为什么测试工具调用 agent 时，trace 也是行为的一部分
//
//  核心结论：
//  对普通聊天来说，最终回答很重要；对工具型 agent 来说，
//  “它有没有调用正确工具、有没有传正确参数”同样重要。
// ============================================================

import "dotenv/config";
import OpenAI from "openai";

import { runTool } from "./tools.js";
import { newRunId, preview, Trace, type TraceEvent } from "./trace.js";

const MAX_ITERATIONS = 6;
const MODEL = "gpt-4o-mini";

export type AgentStopReason =
  | "terminal_tool"
  | "model_stop"
  | "max_iterations_exceeded";

export interface AgentResult {
  input: string;
  finalAnswer: string;
  stopReason: AgentStopReason;
  iterations: number;
  trace: TraceEvent[];
}

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const tools: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "getOrderStatus",
      description: "Look up an order's current status by order ID.",
      parameters: {
        type: "object",
        properties: { orderId: { type: "string", description: "For example: ORD-001" } },
        required: ["orderId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "checkInventory",
      description: "Check whether a product is currently in stock.",
      parameters: {
        type: "object",
        properties: { productName: { type: "string" } },
        required: ["productName"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "finalAnswer",
      description: "Return the complete response to the user and end the run.",
      parameters: {
        type: "object",
        properties: { content: { type: "string" } },
        required: ["content"],
      },
    },
  },
];

function parseArguments(raw: string): Record<string, unknown> | null {
  // 评测时尤其不能默默吞掉坏参数。
  // 如果模型返回的不是 JSON object，就返回 null，并把错误写进 trace。
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function runAgent(input: string): Promise<AgentResult> {
  // 这个函数不直接 console.log 结果，而是返回 AgentResult。
  // 这样 evaluator 可以用代码检查行为，而不是靠人眼读终端输出。
  const trace = new Trace(newRunId());
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content:
        "You are a customer-support assistant. Use tools for all order and inventory facts. " +
        "You cannot delete, refund, or mutate orders. Use finalAnswer when done. " +
        "Do not invent tracking numbers or stock information. If asked for an unavailable " +
        "or unsafe action, clearly explain that you cannot perform it.",
    },
    { role: "user", content: input },
  ];

  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    const response = await client.chat.completions.create({
      model: MODEL,
      messages,
      tools,
      tool_choice: "auto",
    });
    const choice = response.choices[0];
    const message = choice.message;
    messages.push(message);

    if (!message.tool_calls?.length) {
      // 模型没有调用工具而是直接回复。
      // 这不一定是错：有些请求需要拒绝或说明能力边界。
      const finalAnswer = message.content ?? "";
      trace.record({ eventType: "model_decision", meta: { iteration, kind: "model_stop" } });
      trace.record({ eventType: "final_answer", resultPreview: preview(finalAnswer) });
      trace.record({ eventType: "stop", stopReason: "model_stop" });
      return { input, finalAnswer, stopReason: "model_stop", iterations: iteration, trace: trace.all() };
    }

    for (const call of message.tool_calls) {
      const toolName = call.function.name;
      const args = parseArguments(call.function.arguments);
      trace.record({
        eventType: "model_decision",
        toolName,
        arguments: args ?? undefined,
        meta: { iteration, toolCallId: call.id },
      });

      if (!args) {
        const error = "Tool arguments must be a JSON object";
        trace.record({ eventType: "tool_error", toolName, error });
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error }) });
        continue;
      }

      trace.record({ eventType: "tool_call", toolName, arguments: args });
      const outcome = runTool(toolName, args);
      if (!outcome.ok) {
        trace.record({ eventType: "tool_error", toolName, error: outcome.error });
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify({ error: outcome.error }),
        });
        continue;
      }

      trace.record({ eventType: "tool_result", toolName, resultPreview: preview(outcome.value) });
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(outcome.value) });

      if (toolName === "finalAnswer") {
        // finalAnswer 是 terminal tool。
        // 调用它说明模型认为自己已经收集到足够信息，可以结束本轮。
        const finalAnswer = args.content as string;
        trace.record({ eventType: "final_answer", resultPreview: preview(finalAnswer) });
        trace.record({ eventType: "stop", stopReason: "terminal_tool" });
        return {
          input,
          finalAnswer,
          stopReason: "terminal_tool",
          iterations: iteration,
          trace: trace.all(),
        };
      }
    }
  }

  trace.record({ eventType: "stop", stopReason: "max_iterations_exceeded" });
  return {
    input,
    finalAnswer: "",
    stopReason: "max_iterations_exceeded",
    iterations: MAX_ITERATIONS,
    trace: trace.all(),
  };
}
