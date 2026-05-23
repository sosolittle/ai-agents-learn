# Agent Reliability & Observability

> If you cannot see what your agent did, you cannot debug what it got wrong.

In a small demo, it's fine to print tool calls to the console and call it a day. In a real system, that breaks down fast. Once the model is making multiple decisions, calling tools, retrying transient failures, and stopping based on conditions, you need an actual trace of what happened. Not "the final answer looked good" — the sequence of steps that produced it.

This module is about the boundaries and feedback mechanisms that turn an open-ended agent loop into something you can debug, control, and trust.

---

## The mental model

```
User goal
   ↓
Model decision
   ↓
Tool call
   ↓
Tool result / tool error
   ↓
Observation
   ↓
Next decision
   ↓
Final answer or failure
```

Every one of those arrows should be visible. Not in your head — written down, in order, with a run ID you can grep.

If you've built backend services, you already track this kind of thing:

```
Normal request:  request → controller → service → database → response
Agent request:   goal → model decision → tool call → tool result → next decision → answer
```

For the normal request you log status codes, latency, errors, database failures. Agent systems need the same discipline — just at the **step level**. A single user message can produce ten decisions, four tool calls, two retries and a final answer. Logging only the final answer hides the parts that matter when something breaks.

---

## Why this exists

Tool use let the model act. The agent loop let it keep acting. Memory let it carry state across turns. None of those answer the question an engineer asks at 11pm: *what did the agent actually do?*

Without this layer:

- agents can loop forever and you don't notice until the bill arrives
- tool failures are hidden inside model reasoning ("I'll just try a different approach…")
- bad arguments are hard to diagnose because you never see them
- cost grows silently — every retry is another model call
- final answers may not be grounded in any tool result that actually succeeded
- you cannot replay the run to understand what went wrong

A reliable agent is not an agent that never fails. A reliable agent is one that fails **visibly, safely, and debuggably**.

---

## What to track

The trace event in this module is intentionally small. You can extend it later, but starting with too many fields makes nothing get logged consistently.

| Field | Why it matters |
|---|---|
| `runId` | Groups every step from one agent execution. The unit you'll grep by. |
| `stepNumber` | Order of decisions and actions inside the run. |
| `eventType` | `model_decision`, `tool_call`, `tool_result`, `tool_error`, `retry`, `final_answer`, `stop`. |
| `toolName` | Which backend capability was invoked. |
| `arguments` | What arguments the model produced. Most "wrong answer" bugs are wrong arguments. |
| `resultPreview` | A short snippet of the tool's result — not the full payload. |
| `error` | The failure reason, when there is one. |
| `durationMs` | How long the tool took. Slow tools are usually the first thing to break. |
| `stopReason` | Why the loop ended: `terminal_tool`, `max_iterations_exceeded`, `model_stop`. |

You can add `tokenEstimate`, `costEstimate`, `userId`, `requestId` later — but only when you'll actually look at them.

---

## Boundaries every agent loop needs

Reliability isn't one feature. It's a set of boundaries the loop enforces around the model.

**`MAX_ITERATIONS`.** The same circuit breaker from `03-agent-loop`. Without it, a confused model will keep calling tools until something else stops it — usually your rate limit or your wallet.

**Allowed tools.** The dispatcher is the security boundary. The model can ask for any tool name, including ones that don't exist. The loop should reject anything not on the allow-list before dispatching, with a clear error.

**Argument validation.** Tool definitions tell the model what shape arguments should take. They don't enforce it. Validate at the boundary, return a helpful error, and let the model correct itself instead of crashing the run.

**Timeout handling.** A tool that hangs forever wedges the whole agent. `Promise.race` against a timer gives every call a ceiling. The trace shows which tool timed out, so you know where to look.

**Retry policy.** Distinguish retryable errors (timeouts, 503s, transient DB blips) from permanent ones (404, invalid input). Retry the first kind once or twice; surface the second kind immediately so the model can react instead of burning iterations on calls that will fail the same way.

**Terminal tool or stop condition.** Loops need an explicit exit. Either a designated tool the model calls when it's done (`finalAnswer` in this demo), or a `finish_reason === "stop"` check. Without one, "done" is ambiguous.

**Final answer validation.** If your agent must produce structured output, validate it before returning. A run that "completed" with garbage is worse than a run that failed — it gets shipped.

**Trace logging.** Every step gets an event. Recorded as it happens, printed at the end (or shipped to a log service). The trace is the artifact you actually use when something breaks.

---

## Example scenario

Same shape as earlier modules — a small product-support flow with mock tools.

**User goal:** *Check if order ORD-001 has shipped. If the lookup fails, retry once. Then give me a final answer.*

**Mock tools:**

- `getOrderStatus(orderId)` — looks up an order
- `checkInventory(productName)` — checks stock
- `finalAnswer(content)` — the terminal tool that ends the run

`getOrderStatus` is rigged to fail on its first call with a transient error, then succeed on retry. That's the failure pattern we want the trace to make obvious.

What the run looks like:

1. Model decides to call `getOrderStatus("ORD-001")`.
2. The tool fails with a transient `"Temporary database timeout"`.
3. The loop sees `retryable: true` and retries.
4. Second call succeeds — order shipped, tracking `TRK-123`.
5. Model decides to call the terminal tool with the answer.
6. Loop stops with `stopReason: terminal_tool`.

Every one of those steps is in the trace.

---

## Code walkthrough

Three small files:

**[`trace.ts`](./trace.ts)** — the trace recorder. Defines `TraceEvent`, a `Trace` class that holds events for one run, and a `print()` helper that dumps a readable report. In production this would be a writer that ships events to a database, OpenTelemetry exporter, or a service like Langfuse. The shape is the same; only the sink changes.

**[`tools.ts`](./tools.ts)** — mock tools and a dispatcher. Every tool returns a discriminated union: `{ ok: true, value }` or `{ ok: false, error, retryable }`. The `retryable` flag is what lets the loop tell a transient timeout apart from a permanent 404 — that single bit prevents the agent from retrying things that will never succeed.

**[`index.ts`](./index.ts)** — the loop. `MAX_ITERATIONS`, allow-list check, timeout wrapper, per-tool retry counter, terminal tool detection, and a trace event written at every step.

The model is OpenAI's function-calling API (`gpt-4o-mini`). The deterministic part of the demo lives in the *tool*, not the model: `getOrderStatus` fails on its first call and succeeds on the second, so the retry path is exercised on every run. The model never sees the transient failure — that's the whole point of the loop's retry policy, to shield the model from noise the system can recover from on its own.

---

## Run it

```bash
cd 07-reliability-observability
cp .env.example .env
# add your OPENAI_API_KEY to .env

npm install
npm start
```

The model is called via OpenAI's function-calling API. The first call to `getOrderStatus` is rigged to fail with a transient error, so the retry path always runs.

---

## Example output

```
Goal: Check if order ORD-001 has shipped, and tell me the tracking number.

[run uq05hktc]
[step 1] model_decision getOrderStatus
  args: {"orderId":"ORD-001"}
  iteration: 1
  toolCallId: call_0HSXbKrET7QKeLGvnH8s9Zni

[step 2] tool_call getOrderStatus
  args: {"orderId":"ORD-001"}
  attempt: 1

[step 3] tool_error getOrderStatus
  error: Temporary database timeout
  durationMs: 1
  retryable: true
  attempt: 1

[step 4] retry getOrderStatus
  nextAttempt: 2
  reason: Temporary database timeout

[step 5] tool_call getOrderStatus
  args: {"orderId":"ORD-001"}
  attempt: 2

[step 6] tool_result getOrderStatus
  result: {"status":"shipped","trackingNumber":"TRK-123","carrier":"UPS"}
  durationMs: 0

[step 7] model_decision finalAnswer
  args: {"content":"Your order ORD-001 has shipped. The tracking number is TRK-123 and it is being handled by UPS."}
  iteration: 2

[step 8] tool_call finalAnswer
  attempt: 1

[step 9] tool_result finalAnswer
  result: {"final":"Your order ORD-001 has shipped. The tracking number is TRK-123 and it is being handled by UPS."}

[step 10] final_answer
  result: Your order ORD-001 has shipped. The tracking number is TRK-123 and it is being handled by UPS.

[step 11] stop
  stopReason: terminal_tool

────────────────────────────────────────────────────────────
stopReason: terminal_tool
answer: Your order ORD-001 has shipped. The tracking number is TRK-123 and it is being handled by UPS.
```

The exact wording of the final answer will vary — the model composes it. The structure stays the same: the transient failure is visible, the retry is visible, the recovery is visible, and the terminal tool and stop reason are visible. That's the point.

---

## What this example is / is not

**This example is:**

- a minimal traceable agent loop with step-level visibility
- a small demonstration of retry, timeout, and failure handling
- a teaching example for the boundaries an agent loop needs

**This example is not:**

- a production observability platform
- a replacement for OpenTelemetry, Langfuse, LangSmith, or your existing log stack
- a full evaluation system
- a secure agent runtime

The goal is to make the boundaries visible. Real systems add layers; this keeps the concepts in one screen of code.

---

## Production notes

In a real system the trace would not live in memory. It would go to one or more of:

- a database table keyed by `runId`
- a log aggregator (Datadog, Loki, CloudWatch)
- an OpenTelemetry-compatible backend
- an agent tracing tool like Langfuse or LangSmith
- a dashboard engineers actually open when something breaks

A few things that matter once traces leave your laptop:

- **Do not log secrets.** API keys, tokens, passwords — none of these should ever land in a tool argument or result preview. Redact at the boundary.
- **Redact sensitive user data.** PII in tool inputs is PII in your log store. Treat it that way.
- **Don't store full prompts blindly.** Long prompts may contain private user content. Truncate, redact, or store separately under access control.
- **Keep result previews short.** Full payloads belong in cold storage if anywhere — not in every trace event.
- **Carry request and user IDs carefully.** They're invaluable for debugging and a liability if logged in the wrong place.
- **Separate debug logs from audit logs.** Different retention, different access, different purpose. Conflating them is how compliance problems start.

---

## What you should understand after this

- Why a final-answer-only log is not enough once an agent has multiple steps
- What to record at each step and what to leave out
- Why retryable vs. non-retryable matters, and where that decision lives
- Why `MAX_ITERATIONS`, timeouts, allow-lists, and terminal tools are not optional
- How the same trace shape works in memory, in a database, or in an OTel backend

---

## References

- [OpenAI function calling guide](https://platform.openai.com/docs/guides/function-calling) — the tool-call mechanics the loop is shaped around
- [OpenTelemetry documentation](https://opentelemetry.io/docs/) — the standard most production agent tracing eventually maps onto
- [Tool use pattern](../02-tool-use/) — the single-round version of the loop this module instruments
- [Agent loop pattern](../03-agent-loop/) — the multi-step loop this module wraps boundaries around
