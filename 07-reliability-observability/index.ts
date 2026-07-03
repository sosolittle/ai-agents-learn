// ============================================================
//  第七章：reliability-observability（可靠性与可观测性）
//
//  学习目标：
//  1. 理解 agent loop 为什么需要 trace、timeout、retry 和 allow-list
//  2. 学会把模型决策、工具调用、工具结果和停止原因记录下来
//  3. 区分模型能处理的问题和系统应该自动恢复的问题
//  4. 看懂“显式终止工具”如何让 agent 有清晰的完成信号
//
//  核心结论：
//  能跑起来只是第一步。真正可维护的 agent，要能解释“刚才发生了什么”。
// ============================================================

// Reliability & Observability
//
// The agent loop from earlier modules is the skeleton. This module wraps it
// in the things that make it debuggable when something goes wrong:
//   - a trace recorded at every step
//   - a max-iterations circuit breaker
//   - an allow-list of tools the model can call
//   - argument validation at the dispatcher boundary
//   - a per-call timeout
//   - a retry policy for transient errors
//   - an explicit terminal tool and stop reason
//
// The model is OpenAI's function-calling API. The retry behavior is exercised
// by getOrderStatus, which is rigged to fail on its first call with a
// transient error and succeed on the second. The retry happens *inside the
// loop* — the model never sees the transient failure, only the successful
// result on retry. That's the whole point of a retry policy: shield the model
// from noise the system can recover from on its own.

import "dotenv/config";
import OpenAI from "openai";

import { Trace, newRunId, preview } from "./trace";
import { ALLOWED_TOOLS, resetToolState, runTool } from "./tools";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------------------------------------------------------------------------
// Boundaries — the knobs that turn an open-ended loop into a bounded system.
// ---------------------------------------------------------------------------

const MAX_ITERATIONS = 10;
const TOOL_TIMEOUT_MS = 5000;
const MAX_RETRIES_PER_TOOL = 1;
const MODEL = "gpt-4o-mini";

// ---------------------------------------------------------------------------
// Tool definitions — what the model is allowed to ask for.
// ---------------------------------------------------------------------------

const tools: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "getOrderStatus",
      description: "Look up the current status of a customer order by order ID.",
      parameters: {
        type: "object",
        properties: {
          orderId: {
            type: "string",
            description: "Order ID, format: ORD-XXX — e.g. ORD-001",
          },
        },
        required: ["orderId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "checkInventory",
      description: "Check the stock level for a product by its name.",
      parameters: {
        type: "object",
        properties: {
          productName: {
            type: "string",
            description: "Exact product name — e.g. 'Wireless Headphones'",
          },
        },
        required: ["productName"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "finalAnswer",
      description:
        "Return the final answer to the user. Call this once you have gathered " +
        "enough information to fully answer the question. Calling this ends the run.",
      parameters: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "The complete final answer for the user.",
          },
        },
        required: ["content"],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Timeout wrapper. A tool that never returns shouldn't be able to wedge the
// whole agent. Promise.race against a timer gives every call a hard ceiling.
// ---------------------------------------------------------------------------

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  // Promise.race 的思想：工具正常完成和超时计时器谁先结束，就采用谁。
  // 这里手写 Promise 是为了在成功/失败时清理 timer，避免无意义的计时器残留。
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

// ---------------------------------------------------------------------------
// Argument validation. The dispatcher in tools.ts also checks shape, but the
// loop should reject tools not on the allow-list before dispatch. The model
// can hallucinate names; the loop catches that.
// ---------------------------------------------------------------------------

function validateToolName(name: string): string | null {
  // 模型可能幻觉出不存在的工具名。
  // allow-list 用代码明确告诉系统：只有这些工具能执行。
  if (!ALLOWED_TOOLS.has(name)) {
    return `Tool "${name}" is not allowed. Allowed: ${[...ALLOWED_TOOLS].join(", ")}.`;
  }
  return null;
}

// Tool arguments arrive as a JSON string from the model. Parsing can fail —
// the model can hallucinate malformed JSON, send an array, or return null.
// Silently coercing that to `{}` would hide a real bug in the trace, which
// defeats the point of this module. Return a structured outcome instead so
// the loop can record the failure and hand the error back to the model.
type ParsedToolArgs =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; error: string; raw: string };

function parseArgs(raw: string): ParsedToolArgs {
  // 工具参数来自模型生成的 JSON 字符串。
  // 这里不把错误吞成空对象，而是返回结构化错误，方便 trace 记录。
  try {
    const parsed = JSON.parse(raw);

    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "Tool arguments must be a JSON object", raw };
    }

    return { ok: true, args: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, error: "Invalid JSON arguments from model", raw };
  }
}

// ---------------------------------------------------------------------------
// runToolWithRetries — runs one tool, applies timeout, retries transient
// errors up to MAX_RETRIES_PER_TOOL. Returns the final outcome (success or
// the last error). Every attempt and retry is recorded in the trace.
// ---------------------------------------------------------------------------

interface ResolvedResult {
  ok: boolean;
  payload: string; // What we hand back to the model as the tool result.
  value?: unknown;
}

async function runToolWithRetries(
  trace: Trace,
  toolName: string,
  args: Record<string, unknown>
): Promise<ResolvedResult> {
  // 这一层负责“系统级恢复”：
  // 工具临时失败时，先由代码重试，而不是立刻把噪音暴露给模型。
  let attempt = 0;

  while (true) {
    attempt++;

    trace.record({
      eventType: "tool_call",
      toolName,
      arguments: args,
      meta: { attempt },
    });

    const startedAt = Date.now();
    try {
      const outcome = await withTimeout(runTool(toolName, args), TOOL_TIMEOUT_MS, toolName);
      const durationMs = Date.now() - startedAt;

      if (outcome.ok) {
        trace.record({
          eventType: "tool_result",
          toolName,
          resultPreview: preview(outcome.value),
          durationMs,
        });
        return { ok: true, payload: JSON.stringify(outcome.value), value: outcome.value };
      }

      trace.record({
        eventType: "tool_error",
        toolName,
        error: outcome.error,
        durationMs,
        meta: { retryable: outcome.retryable, attempt },
      });

      // Permanent error or out of retries — hand the error back to the model
      // so it can decide what to do (apologize, try a different tool, etc).
      if (!outcome.retryable || attempt > MAX_RETRIES_PER_TOOL) {
        return { ok: false, payload: JSON.stringify({ error: outcome.error }) };
      }

      // Retry. Recorded explicitly so silent retries don't hide cost growth.
      trace.record({
        eventType: "retry",
        toolName,
        meta: { nextAttempt: attempt + 1, reason: outcome.error },
      });
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      const message = err instanceof Error ? err.message : String(err);

      trace.record({ eventType: "tool_error", toolName, error: message, durationMs });

      if (attempt > MAX_RETRIES_PER_TOOL) {
        return { ok: false, payload: JSON.stringify({ error: message }) };
      }

      trace.record({
        eventType: "retry",
        toolName,
        meta: { nextAttempt: attempt + 1, reason: message },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// The loop.
// ---------------------------------------------------------------------------

async function runAgent(userGoal: string): Promise<{ answer: string | null; stopReason: string }> {
  // runAgent 把前面几章的模式组合起来：
  // messages 保存上下文，tools 描述能力，trace 记录证据，循环控制停止条件。
  const trace = new Trace(newRunId());
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content:
        "You are a customer support agent. Use the tools to look up real " +
        "information before answering. When you have enough information, call " +
        "finalAnswer with the complete reply for the user.",
    },
    { role: "user", content: userGoal },
  ];

  console.log(`Goal: ${userGoal}`);

  let iteration = 0;

  while (true) {
    iteration++;

    if (iteration > MAX_ITERATIONS) {
      const stopReason = "max_iterations_exceeded";
      trace.record({ eventType: "stop", stopReason });
      trace.print();
      return { answer: null, stopReason };
    }

    const response = await client.chat.completions.create({
      model: MODEL,
      messages,
      tools,
      tool_choice: "auto",
    });

    const choice = response.choices[0];
    const message = choice.message;
    messages.push(message);

    // Model replied without calling a tool. Treat as a final answer.
    if (choice.finish_reason === "stop" || !message.tool_calls?.length) {
      const content = message.content ?? null;
      const stopReason = "model_stop";
      trace.record({
        eventType: "model_decision",
        meta: { iteration, kind: "direct_reply" },
      });
      trace.record({ eventType: "final_answer", resultPreview: preview(content) });
      trace.record({ eventType: "stop", stopReason });
      trace.print();
      return { answer: content, stopReason };
    }

    // Model asked for one or more tool calls. The function-calling API can
    // batch independent calls into one round — iterate them all.
    //
    // Calls run sequentially, not in parallel (no Promise.all). Parallel
    // execution would interleave trace events from concurrent calls with no
    // guaranteed ordering, making the trace harder to read and reason about.
    for (const call of message.tool_calls) {
      const toolName = call.function.name;
      const parsedArgs = parseArgs(call.function.arguments);

      // Malformed arguments — record the failure and send the error back to
      // the model so it can correct itself. Don't crash, don't coerce to {}.
      if (!parsedArgs.ok) {
        // model_decision must always be recorded before tool_error so the trace
        // tells a coherent story: the model asked for something, then it failed.
        trace.record({
          eventType: "model_decision",
          toolName,
          meta: { iteration, toolCallId: call.id, parseError: parsedArgs.error },
        });
        trace.record({
          eventType: "tool_error",
          toolName,
          error: parsedArgs.error,
          meta: { iteration, toolCallId: call.id, rawArguments: parsedArgs.raw },
        });
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify({ error: parsedArgs.error }),
        });
        continue;
      }

      const args = parsedArgs.args;

      trace.record({
        eventType: "model_decision",
        toolName,
        arguments: args,
        meta: { iteration, toolCallId: call.id },
      });

      const validationError = validateToolName(toolName);
      if (validationError) {
        trace.record({ eventType: "tool_error", toolName, error: validationError });
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify({ error: validationError }),
        });
        continue;
      }

      const result = await runToolWithRetries(trace, toolName, args);

      // Terminal tool — explicit completion. Push the result for a valid
      // message history, then exit.
      if (toolName === "finalAnswer" && result.ok) {
        const content = (result.value as { final: string }).final;
        messages.push({ role: "tool", tool_call_id: call.id, content: result.payload });
        const stopReason = "terminal_tool";
        trace.record({ eventType: "final_answer", resultPreview: preview(content) });
        trace.record({ eventType: "stop", stopReason });
        trace.print();
        return { answer: content, stopReason };
      }

      messages.push({ role: "tool", tool_call_id: call.id, content: result.payload });
    }
  }
}

// ---------------------------------------------------------------------------
// Demo
// ---------------------------------------------------------------------------

async function main() {
  resetToolState();
  const result = await runAgent(
    "Check if order ORD-001 has shipped, and tell me the tracking number."
  );

  console.log("─".repeat(60));
  console.log(`stopReason: ${result.stopReason}`);
  console.log(`answer: ${result.answer ?? "(none)"}`);
}

main().catch((err) => {
  console.error("Agent crashed:", err);
  process.exit(1);
});
