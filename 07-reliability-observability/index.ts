// ============================================================
//  第七章：reliability-observability（可靠性与可观测性）
//
//  🏠 生活化比喻（接着前六章的故事讲）：
//  那位新员工已经很能干了：会用工具（02）、能跑整项任务（03）、
//  会搜网抓页（04/05）、有了记忆（06）。这一章不发新技能，
//  发两样「职业保障」：
//
//   ① 安全生产规范——四道防线：
//     · 沙漏（timeout）：每个工具 5 秒内必须出结果，超时作废；
//     · 自动重试（retry）：临时故障系统自己扛，修好了再上菜；
//     · 工具白名单（allow-list）：没登记的工具一律不执行；
//     · 保险丝（MAX_ITERATIONS）：循环最多 10 圈。
//   ② 行车记录仪（trace，见 trace.ts）：每一步决策、调用、结果、
//     失败、重试、停止都记成带编号的事件流——出事后能逐秒回放。
//
//  本章的核心剧情：getOrderStatus 被故意装了「第一次必失败」的
//  机关（tools.ts）。第一次调用失败后，重试逻辑在系统层悄悄补救——
//  模型从头到尾只看到成功的结果。这就是本章最重要的分界线：
//    系统能自动恢复的（临时故障）→ 不劳烦模型；
//    模型该处理的（永久错误）→ 原样上交，让它决定怎么办。
//
//  学习目标：
//  1. 理解 agent loop 为什么需要 trace、timeout、retry 和 allow-list
//  2. 学会把模型决策、工具调用、工具结果和停止原因记录下来
//  3. 区分模型能处理的问题和系统应该自动恢复的问题
//  4. 看懂“显式终止工具”如何让 agent 有清晰的完成信号
//
//  核心结论：
//  能跑起来只是第一步。真正可维护的 agent，要能解释“刚才发生了什么”——
//  而且大部分小故障应该在被你看到之前，就已经被系统自己修好了。
//
//  本模块文件导航：
//  - index.ts（本文件）：主循环 + 超时/重试/白名单/终止
//  - tools.ts：mock 后端工具 + 分发器（含「第一次必失败」的机关）
//  - trace.ts：飞行记录仪（事件流 + 打印）
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
// （重试发生在循环内部——模型从没见过那次临时失败。
//   这就是重试策略的全部意义：替模型挡掉系统自己能恢复的噪音。）

import "dotenv/config";
import OpenAI from "openai";
// 本模块拆成三个文件（前几章是单文件）——主循环、工具、记录仪各管一摊。
// 相对路径导入自己项目里的模块。
import { Trace, newRunId, preview } from "./trace";
import { ALLOWED_TOOLS, resetToolState, runTool } from "./tools";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------------------------------------------------------------------------
// 第一部分：边界常量——把开放式循环变成有界系统的四个旋钮
// Boundaries — the knobs that turn an open-ended loop into a bounded system.
// 每个常量都在回答一个「万一……怎么办」：
//   MAX_ITERATIONS = 10       万一模型停不下来？——最多转 10 圈
//   TOOL_TIMEOUT_MS = 5000    万一工具卡死？——5 秒强制掐断
//   MAX_RETRIES_PER_TOOL = 1  万一临时失败？——重试 1 次（2 次调用总共）
//   MODEL = "gpt-4o-mini"     用哪个模型（提出来当常量，换模型只改一处）
// ---------------------------------------------------------------------------

const MAX_ITERATIONS = 10;
const TOOL_TIMEOUT_MS = 5000;
const MAX_RETRIES_PER_TOOL = 1;
const MODEL = "gpt-4o-mini";

// ---------------------------------------------------------------------------
// 第二部分：工具定义——模型能「点名的菜」（同前几章的讲法）
// getOrderStatus / checkInventory 是干活工具；finalAnswer 是收工单
// （终止工具，description 写明「调用即结束本次运行」）。
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
// 第三部分：withTimeout——给每次工具调用罩一个「沙漏」
// Timeout wrapper. A tool that never returns shouldn't be able to wedge the
// whole agent. Promise.race against a timer gives every call a hard ceiling.
// 一个永不返回的工具不该能卡死整个 agent——给每次调用加硬上限。
//
// 思想是「赛马」：工具完成和 5 秒计时器同时起跑，谁先冲线听谁的。
// 计时器先到 → 判超时（reject 一个 Error）；工具先到 → 用它的结果。
// ---------------------------------------------------------------------------

// TS 语法：<T> 是泛型——函数的「类型占位符」。
// 调 withTimeout(somePromise) 时 T 自动等于 somePromise 的元素类型：
//   withTimeout(runTool(...), …) → T 是 ToolOutcome
// 于是成功时 resolve 的类型和传入的 Promise 完全一致，不用 any。
// 这是本系列出现的第一个泛型函数，值得多看两眼。
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  // Promise.race 的思想：工具正常完成和超时计时器谁先结束，就采用谁。
  // 这里手写 Promise 是为了在成功/失败时清理 timer，避免无意义的计时器残留。
  //
  // 拆解这个手写 Promise：
  //   new Promise((resolve, reject) => …)  造一张新的「凭证」，把
  //   「何时算成功 / 何时算失败」的控制权拿到自己手里；
  //   setTimeout(() => reject(…), ms)      ms 毫秒后判超时；
  //   p.then(v => { clearTimeout; resolve(v) })  工具先到 → 成功，并撤掉沙漏；
  //   p.then(_, e => { clearTimeout; reject(e) })  工具失败 → 失败，也撤掉沙漏。
  // clearTimeout 很重要：不清理的话，即使早已成功，5 秒后那个
  // 定时器还是会空跑一次（Node 进程里堆积多了会拖慢退出）。
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
// 第四部分：两道「入口检查」——工具名白名单 + 参数解析
// ---------------------------------------------------------------------------

function validateToolName(name: string): string | null {
  // 模型可能幻觉出不存在的工具名。
  // allow-list 用代码明确告诉系统：只有这些工具能执行。
  // 返回约定同 05 章的安检员：null = 放行；字符串 = 拒绝原因。
  // TS 语法：[...ALLOWED_TOOLS] 把 Set 展开成数组——
  // Set 没有 join 方法，数组才有（用来把名单拼进错误提示）。
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
// 模型发来的参数是 JSON 字符串，解析可能失败。
// 04/05 章的做法是「失败就当 {}」——demo 里够用，但会把真实 bug
// 吞进无害的默认值里。本章是可靠性专题，必须让失败「有形有据」：
// 解析失败就返回结构化错误，记进 trace、退回模型，让它自纠。
//
// TS 语法：又一个可辨识联合（同 tools.ts 的 ToolOutcome）——
// ok 字段当标签，两个分支各带各的字段。调用方 if (!parsed.ok)
// 之后，TS 自动收窄到 error/raw 分支，errors 和 args 不会用错。
// 📤 走查（三种输入、三种输出）：
//   '{"orderId":"ORD-001"}' → { ok: true,  args: {orderId: "ORD-001"} }
//   '"just a string"'       → { ok: false, error: "…must be a JSON object" }
//     （JSON.parse 成功，但结果是字符串，不是对象）
//   '[1,2]'                 → { ok: false, error: "…must be a JSON object" }
//     （数组也是合法 JSON，但工具参数必须是对象）
//   '{"orderId": '          → { ok: false, error: "Invalid JSON…" }
//     （截断的 JSON，JSON.parse 直接 throw，进 catch）
type ParsedToolArgs =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; error: string; raw: string };

function parseArgs(raw: string): ParsedToolArgs {
  // 工具参数来自模型生成的 JSON 字符串。
  // 这里不把错误吞成空对象，而是返回结构化错误，方便 trace 记录。
  try {
    const parsed = JSON.parse(raw);

    // 三重排错：null（'null' 是合法 JSON）、非对象（字符串/数字）、数组。
    // 逐个解释：
    //   parsed === null              JSON.parse("null") → null
    //   typeof parsed !== "object"   字符串/数字/布尔都不是对象
    //                                （typeof null === "object" 是 JS 著名
    //                                 历史遗留坑，所以 null 要单独先判）
    //   Array.isArray(parsed)        数组的 typeof 也是 "object"，单独排除
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "Tool arguments must be a JSON object", raw };
    }

    return { ok: true, args: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, error: "Invalid JSON arguments from model", raw };
  }
}

// ---------------------------------------------------------------------------
// 第五部分：runToolWithRetries——本章的「系统级恢复」核心
// runs one tool, applies timeout, retries transient errors up to
// MAX_RETRIES_PER_TOOL. Returns the final outcome (success or the last
// error). Every attempt and retry is recorded in the trace.
// 每次尝试都过沙漏；临时错误重试；永久错误或重试用尽就上交。
// 所有尝试与重试都记进 trace——静默重试等于隐藏成本增长。
// ---------------------------------------------------------------------------

interface ResolvedResult {
  ok: boolean;
  payload: string; // What we hand back to the model as the tool result.
  // payload：最终塞回 messages 的 tool 结果（JSON 文本）——
  // 模型看到的永远是这份，中间的失败重试它一概不知。
  // value?: unknown — 原始数据，终止工具取 final 字段时用。
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

  // 循环唯一的退出方式是 return（成功 / 永久错误 / 重试用尽），
  // 不会有「转着转着自己停下来」的路径。
  while (true) {
    attempt++;

    // 先记账再干活：每一次尝试都是一条可追溯的记录。
    trace.record({
      eventType: "tool_call",
      toolName,
      arguments: args,
      meta: { attempt },
    });

    const startedAt = Date.now();
    try {
      // 沙漏套在外面：runTool 卡死 5 秒也会被掐断（掐断 = reject = 进 catch）。
      const outcome = await withTimeout(runTool(toolName, args), TOOL_TIMEOUT_MS, toolName);
      const durationMs = Date.now() - startedAt;

      // 类型收窄：outcome.ok 为 true → 这是 ToolResult，有 value。
      if (outcome.ok) {
        trace.record({
          eventType: "tool_result",
          toolName,
          resultPreview: preview(outcome.value),
          durationMs,
        });
        // 成功：value 序列化成 JSON 文本交给模型。
        return { ok: true, payload: JSON.stringify(outcome.value), value: outcome.value };
      }

      // 失败：先记 tool_error（带 retryable 和 attempt，方便事后审计）。
      trace.record({
        eventType: "tool_error",
        toolName,
        error: outcome.error,
        durationMs,
        meta: { retryable: outcome.retryable, attempt },
      });

      // Permanent error or out of retries — hand the error back to the model
      // so it can decide what to do (apologize, try a different tool, etc).
      // 永久错误，或重试次数用完：不再重试，把错误作为结果上交模型——
      // 「这道菜做不出来」该让点单的人知道，他可以道歉或换一道。
      if (!outcome.retryable || attempt > MAX_RETRIES_PER_TOOL) {
        return { ok: false, payload: JSON.stringify({ error: outcome.error }) };
      }

      // Retry. Recorded explicitly so silent retries don't hide cost growth.
      // 重试本身也记账——「静默重试」是成本悄悄翻倍的惯犯。
      // （attempt=1、MAX=1：这次重试是第 2 次也是最后一次机会。）
      trace.record({
        eventType: "retry",
        toolName,
        meta: { nextAttempt: attempt + 1, reason: outcome.error },
      });
    } catch (err) {
      // 走到 catch 的只有一种东西：withTimeout 掐断的超时（reject）。
      const durationMs = Date.now() - startedAt;
      const message = err instanceof Error ? err.message : String(err);

      trace.record({ eventType: "tool_error", toolName, error: message, durationMs });

      // 超时视为临时故障：还有重试额度就再来一次，否则上交。
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
// 第六部分：主循环——前几章的骨架 + 本章的四道防线 + 黑匣子
// ---------------------------------------------------------------------------

// TS 语法：返回对象类型 { answer: string | null; stopReason: string }
// ——一次返回两个值（答案 + 停止原因）。answer 为 null 表示
// 「没拿到答案」（比如保险丝熔断），stopReason 说明为什么。
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

    // 防线 ①：保险丝。注意熔断时也留下「案发记录」再离开——
    // stop 事件 + 完整 trace 打印，answer 为 null 让调用方明确知道失败。
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
    // 出口 A：模型直接说话（没调工具）。finish_reason 为 "stop"、
    // 或干脆没有 tool_calls，都按「直接回答」处理。
    // stopReason 记为 "model_stop"——和终止工具区分开：
    // 同样是结束，这两种结束的可信度不一样。
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
    // （模型可以一轮同时点几道菜。这里逐道顺序执行，不并行——
    //   并行会让多个调用的 trace 事件交错乱序，黑匣子反而难读了。）
    for (const call of message.tool_calls) {
      const toolName = call.function.name;
      // 防线 ②：参数解析。坏参数 → 记录 + 退回模型自纠（不崩、不吞）。
      const parsedArgs = parseArgs(call.function.arguments);

      // Malformed arguments — record the failure and send the error back to
      // the model so it can correct itself. Don't crash, don't coerce to {}.
      if (!parsedArgs.ok) {
        // model_decision must always be recorded before tool_error so the trace
        // tells a coherent story: the model asked for something, then it failed.
        // 记账顺序有讲究：先记 model_decision（模型想要什么），
        // 再记 tool_error（为什么没成）——黑匣子读起来才是完整因果。
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

      // 类型收窄：!parsedArgs.ok 的分支已 return/continue，
      // 走到这里 TS 确定是成功分支，args 一定存在。
      const args = parsedArgs.args;

      trace.record({
        eventType: "model_decision",
        toolName,
        arguments: args,
        meta: { iteration, toolCallId: call.id },
      });

      // 防线 ③：白名单。没登记的工具名 → 记录 + 拒绝。
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

      // 防线 ④：沙漏 + 重试都在 runToolWithRetries 里（见第五部分）。
      const result = await runToolWithRetries(trace, toolName, args);

      // Terminal tool — explicit completion. Push the result for a valid
      // message history, then exit.
      // 出口 B：收工单。先补齐 tool 应答再退出（保持 messages 合法）。
      if (toolName === "finalAnswer" && result.ok) {
        // TS 语法：value 是 unknown，要先断言形状才能取字段。
        // （这里敢断言，是因为 finalAnswer 工具的 value 必是 { final }。）
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
// 第七部分：Demo——亲眼看一次「失败 → 重试 → 成功」的完整轨迹
// ---------------------------------------------------------------------------

async function main() {
  // 把 tools.ts 里「第一次必失败」的计数器拨回 0——
  // 每次运行都从「第 1 次调用」开始，demo 行为可复现。
  resetToolState();
  const result = await runAgent(
    "Check if order ORD-001 has shipped, and tell me the tracking number."
  );

  console.log("─".repeat(60));
  console.log(`stopReason: ${result.stopReason}`);
  console.log(`answer: ${result.answer ?? "(none)"}`);
  // result.answer 为 null 时打印 "(none)"——比如保险丝熔断的那种结局。
}

// 顶层兜底：接住所有未处理异常并打出「Agent crashed」。
// process.exit(1)：以非零退出码结束进程——脚本能据此判断「失败了」
// （CI / shell 脚本里 $? 为 1）。
main().catch((err) => {
  console.error("Agent crashed:", err);
  process.exit(1);
});

// ============================================================
//  📤 附：Demo 预期输出（控制台大意；runId 每次随机）
//
//  Goal: Check if order ORD-001 has shipped, and tell me the tracking number.
//
//  （对话静默进行，结束时黑匣子一次性倒放：）
//
//  [run k3x9f2ab]
//  [step 1] model_decision getOrderStatus
//    args: {"orderId":"ORD-001"}
//    iteration: 1
//  [step 2] tool_call getOrderStatus
//    args: {"orderId":"ORD-001"}
//    attempt: 1
//  [step 3] tool_error getOrderStatus
//    error: Temporary database timeout
//    durationMs: 2
//    retryable: true        ← 临时故障：值得重试
//    attempt: 1
//  [step 4] retry getOrderStatus
//    nextAttempt: 2
//    reason: Temporary database timeout
//  [step 5] tool_call getOrderStatus
//    attempt: 2
//  [step 6] tool_result getOrderStatus
//    result: {"status":"shipped","trackingNumber":"TRK-123","carrier":"UPS"}
//    durationMs: 1
//  [step 7] model_decision finalAnswer
//    args: {"content":"Order ORD-001 has shipped via UPS…"}
//    iteration: 2
//  [step 8] tool_call finalAnswer
//    attempt: 1
//  [step 9] tool_result finalAnswer
//    result: {"final":"Order ORD-001 has shipped via UPS…"}
//  [step 10] final_answer
//    result: Order ORD-001 has shipped via UPS…
//  [step 11] stop
//    stopReason: terminal_tool
//
//  ─────────────────────────────────────
//  stopReason: terminal_tool
//  answer: Order ORD-001 has shipped via UPS. The tracking number is TRK-123.
//
//  三个值得体会的点：
//   1. step 3 的「Temporary database timeout」模型从未见过——
//      重试在系统层把它吸收了，模型拿到的 step 6 结果干干净净。
//      「系统级恢复」与「模型级决策」的分界线就在这里；
//   2. 每个事件都有 stepNumber，从上往下读就是完整的因果故事：
//      想决策 → 去调用 → 失败了 → 重试 → 成功 → 收工。没有 grep；
//   3. stopReason 是「可编程的结束」：terminal_tool（主动交单）/
//      model_stop（直接说话）/ max_iterations_exceeded（熔断）——
//      调用方拿字符串就能分流处理，不用猜。
// ============================================================
