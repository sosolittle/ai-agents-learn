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
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function runAgent(input: string): Promise<AgentResult> {
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
