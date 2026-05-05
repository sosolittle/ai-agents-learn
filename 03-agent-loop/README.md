# Agent Loop

> The model doesn't answer your question. It pursues your goal.

In tool use, you ask a question and the model calls tools until it can answer. You're still in the driver's seat — one query, one answer.

In an agent loop, you hand the model a **goal** and step back. The model decides what to do first, what to do next, and when the task is done. It loops until it gets there — or until you stop it.

---

## Where you already see this pattern

Every AI assistant that works on a multi-step task without asking you for direction at every step is running an agent loop:

- **GitHub Copilot Workspace** — you describe a feature, it reads your codebase, plans changes, edits files, and proposes a PR without you scripting each step
- **Devin and similar coding agents** — given a bug report, the agent reads code, runs tests, makes edits, and iterates until the tests pass
- **ChatGPT with Python execution** — given a data file, it loads it, runs analysis code, inspects the output, and refines its approach across multiple executions
- **AI research assistants** — given a topic, they search, read pages, take notes, and synthesize a report over many steps
- **Autopilot-style agents in tools like Cursor** — you describe what to fix, it reads files, makes edits, and verifies the change without hand-holding

What they all have in common: the model is in a loop, making its own decisions each iteration, until the goal is reached.

---

## The mental model

If you've written a Node.js event loop or a Redux reducer, you already understand this.

```
Redux:       dispatch(action) → reducer(state, action) → new state → loop
Agent loop:  model calls tool → you run it → result enters state → model decides next action → loop
```

The message history is the state. Each tool call is an action. The loop continues until a terminal condition is hit.

And like any `while (true)` loop, the bugs are obvious once you see them:
- No exit condition → runs forever
- State grows unbounded → memory/context overflow
- Wrong exit condition → stops too early or too late

The difference is that **you don't control the loop body** — the model does. That's what makes it powerful and what makes it dangerous.

---

## How it works

The loop is the same `finish_reason` check you saw in tool use — but now it runs for many iterations, not just one:

```
You:    [system prompt, user goal]
              ↓
Iteration 1:
  Model:  → list_files()                    finish_reason: "tool_calls"
  You:    run tool, push result
              ↓
Iteration 2:
  Model:  → read_file("src/auth.ts")        finish_reason: "tool_calls"
  You:    run tool, push result
              ↓
Iteration 3–5: model reads remaining files
              ↓
Iteration 6:
  Model:  → write_report("# Security...")   finish_reason: "tool_calls"
  You:    detect terminal tool, exit loop
              ↓
Done.
```

The model decides what to call each round. It reads files in whatever order makes sense to it. You never tell it the sequence.

---

## The two exit conditions

### 1. `finish_reason === "stop"`

The model stops calling tools and replies directly. This is how tool use ends. In an agent loop it can happen too — though in goal-directed agents it's less common because the model usually calls a terminal tool when it's done.

### 2. Terminal tool

A tool whose purpose is to signal completion — `write_report` in this example. When the model calls it, you know the task is done. This is more reliable than `"stop"` alone because the model **explicitly commits** to a final output rather than just stopping.

```ts
// Write the terminal tool result, then exit the loop.
if (call.function.name === "write_report" && finalReport !== null) {
  messages.push({ role: "tool", tool_call_id: call.id, content: result });
  return finalReport;
}
```

Design your terminal tool so the model can only call it when the work is genuinely complete. The description matters:

```ts
// ❌ too vague — model might call this mid-task
description: "Write a report"

// ✅ specific — model knows this is the final step
description:
  "Write the final security audit report. Call this once you have reviewed " +
  "every file and compiled all findings. Calling this ends the audit."
```

---

## The most important constant

```ts
const MAX_ITERATIONS = 15;
```

This is the circuit breaker. Every agent needs one.

Without it, a model that gets confused — bad prompt, unexpected tool result, ambiguous goal — will loop until you hit a rate limit or run out of API budget. With it, you get a clear error and a place to debug.

```ts
if (iteration > MAX_ITERATIONS) {
  throw new Error(
    `Agent exceeded ${MAX_ITERATIONS} iterations without completing the task. ` +
    `This usually means the model is stuck in a loop or the goal is too vague.`
  );
}
```

The right value depends on the task. For a codebase with 4 files, 15 is generous. For an agent that searches the web across dozens of pages, you might need 50. The point is that the number is **intentional** — not infinite.

---

## Why the context window matters

Each iteration appends messages to the conversation history. After 10 iterations, the messages array is 10x larger than after the first. For long-running agents on large tasks, this is the real scaling constraint — not the API cost.

```
Iteration 1:  [system, user]                           ~200 tokens
Iteration 2:  [system, user, asst, tool]               ~800 tokens
Iteration 3:  [system, user, asst, tool, asst, tool]   ~1,800 tokens
...
Iteration 20: potentially 10,000+ tokens
```

In production agents, you truncate old messages, summarize earlier steps, or use a dedicated memory system. Here we keep the full history for clarity — the concept comes first.

---

## The details most developers miss

**The model can read the same file twice.** If your system prompt says "review all files" but doesn't track which ones have been read, the model might re-read `auth.ts` after reading `db.ts`. In this demo the system prompt handles it; in production you often need explicit state tracking.

**Parallel tool calls still apply.** If two files can be read independently, the model may request both in the same iteration — `tool_calls` is still an array. The loop handles this correctly: iterate all calls, push all results.

**The goal needs a clear completion condition.** "Audit this codebase" is clear because the terminal tool (`write_report`) defines done. "Improve the code" has no natural endpoint — the model either loops forever or stops arbitrarily. Vague goals without a terminal condition are the most common source of runaway agents.

---

## What this example is / is not

**This example is:**
- a minimal runnable agent loop showing multi-step, goal-directed behaviour
- a demonstration of the terminal tool pattern for explicit completion
- intentionally built with mock data so the concept is easy to follow without external setup

**This example is not:**
- a production agent framework
- a real file system reader or security scanner
- an implementation with memory, summarisation, or context management
- a replacement for proper agent orchestration in real applications

The goal is to make the loop visible. Real agents add layers on top; this example keeps the concept clear.

---

## Run it

```bash
cp .env.example .env
# add your OPENAI_API_KEY to .env

npm install
npm start
```

You'll see each iteration logged as the agent works through the codebase:

```
Goal: Audit this codebase for security vulnerabilities. Review every file before writing your report.

[iteration 1]
  → list_files()
  ← ["src/auth.ts","src/db.ts","src/api.ts","src/utils.ts"]

[iteration 2]
  → read_file({"path":"src/auth.ts"})
  ← import jwt from "jsonwebtoken";…

[iteration 3]
  → read_file({"path":"src/db.ts"})
  ← import mysql from "mysql2";…
```

---

## Example output

Here is a realistic transcript for the full run:

```
Goal: Audit this codebase for security vulnerabilities. Review every file before writing your report.

[iteration 1]
  → list_files()
  ← ["src/auth.ts","src/db.ts","src/api.ts","src/utils.ts"]

[iteration 2]
  → read_file({"path":"src/auth.ts"})
  ← import jwt from "jsonwebtoken";
export function createToken(userId: string) {
  return jwt.sign({ userId }, "hardcoded-secret-…

[iteration 3]
  → read_file({"path":"src/db.ts"})
  ← import mysql from "mysql2";
export function getConnection() {
  return mysql.createConnection({
    host: "localho…

[iteration 4]
  → read_file({"path":"src/api.ts"})
  ← import express from "express";
import { queryUser } from "./db";
const app = express();
app.use(express.js…

[iteration 5]
  → read_file({"path":"src/utils.ts"})
  ← export function formatDate(date: Date): string {
  return date.toISOString().split("T")[0];
}…

[iteration 6]
  → write_report({"content":"# Security Audit Report\n\n..."})
  ← report written (1842 chars)

────────────────────────────────────────────────────────────

Final report:

# Security Audit Report

## Critical

### src/auth.ts — Hardcoded JWT Secret
...

## High

### src/db.ts — SQL Injection
...

### src/db.ts — Hardcoded Database Credentials
...

## Medium

### src/api.ts — Path Traversal Risk
...

## No Issues Found

### src/utils.ts
No security concerns identified.
```

The exact wording and ordering will vary because the model composes the report. The structure (Critical → High → Medium) is guided by the system prompt.

---

## References

- [OpenAI Function Calling guide](https://platform.openai.com/docs/guides/function-calling) — tool calling mechanics, same as used here
- [Tool use pattern](../02-tool-use/index.ts) — the simpler version: one query, one answer, no autonomous goal pursuit
- [OpenAI Agents overview](https://platform.openai.com/docs/guides/agents) — higher-level framing of what agents are and when to use them
