# Agent Routing

> Not every request deserves the full agent workflow.

## Why this exists

By now we have tool use, an agent loop, memory, observability, evaluation, and multi-agent design. Each of those answers *how* an agent does work. The next production question is different: **which path should run for this request at all?**

A real system gets a mix of requests. Some need a one-line answer. Some need a single backend call. Some need research, or a planner-worker-reviewer flow, or a human signature, or a hard "no." Treating them all the same is the trap:

- If every request goes through the full agent stack, the system becomes slow and expensive — you pay for planning, tools, and multiple model calls on a question that needed one sentence.
- If every request gets direct answering, complex or risky tasks are under-controlled — a refund or a production-data change runs as casually as a definition lookup.

**Routing is the boundary that chooses the smallest safe workflow.** It runs first, it is cheap, and its only job is to decide where the request goes — not to do the work.

## The mental model

```text
User request
   ↓
Router
   ↓
direct answer | tool use | research | multi-agent | human approval | refuse
```

- The **router** classifies the request into exactly one route.
- Each route is a different execution path with a different cost and risk profile.
- The router decides; the handlers execute. Those two responsibilities stay separate.
- The decision is a typed object, not a free-form chat message — so it can be logged, evaluated, and audited.

## What this module demonstrates

| Route | When to use | Example |
|---|---|---|
| `direct_answer` | Simple explanation or general knowledge, no tools needed | "Explain what an API is in simple terms." |
| `tool_use` | One backend/system function call | "Check the delivery status of order ORD-001." |
| `research` | Search, scraping, or gathering external/up-to-date sources | "Compare the latest pricing of two AI API providers." |
| `multi_agent` | Planning, drafting, reviewing, or role separation | "Create a practical MVP plan for a habit tracking app." |
| `human_approval` | Irreversible, financial, account, or production-data action | "Refund this customer and cancel their subscription." |
| `refuse` | Unsafe or unsupported request | "Delete all production users from the database." |

## Example scenario

The module routes six requests in one run, chosen so each takes a different path:

1. **"Explain what an API is in simple terms."** → `direct_answer`. General knowledge, no tools, no side effects. The cheapest path.
2. **"Check the delivery status of order ORD-001."** → `tool_use`. One system call (`getOrderStatus`). No planning needed.
3. **"Compare the latest pricing of two AI API providers."** → `research`. Needs current external sources, so it goes to a search/research agent.
4. **"Create a practical MVP plan for a habit tracking app."** → `multi_agent`. Benefits from planning, drafting, and review — the flow from module 09.
5. **"Refund this customer and cancel their subscription."** → `human_approval`. Financial and irreversible. It should pause, not run automatically.
6. **"Delete all production users from the database."** → `refuse`. Destructive and unsafe. It is blocked.

Notice the spread: only one of the six needs the full multi-agent workflow, and two should never execute on their own. That is the whole point — routing keeps the expensive and dangerous paths rare.

## Code walkthrough

- **`index.ts`** — the entry point. Defines the example requests, and for each one: prints the request, runs the router, prints the decision, dispatches to a mock handler, and prints the result. Ends with a routing summary — the artifact you would log or evaluate.
- **`routerAgent.ts`** — `runRouterAgent(request)`. The single model call. A strict system prompt asks for JSON only and tells the model to pick the *cheapest safe* route. Returns a validated `RouterDecision`.
- **`handlers.ts`** — `dispatch(request, decision)`. One mock handler per route. These do not do real work; they describe the path the request would take. In production these would be the entry points to your real subsystems.
- **`types.ts`** — the contracts: `RouteName`, `RouterDecision` (the validated router output), and `RoutedRequest`. The schema is what makes a routing decision safe to act on.
- **`utils.ts`** — `safeJsonParse`, `printSection`, and a JSON pretty-printer. The JSON parsing is defensive: invalid JSON or a wrong shape throws a clear, labelled error.
- **`config.ts`** — the OpenAI client and model settings, in one place.

## Run it

```bash
cd 10-routing
cp .env.example .env
# add your OPENAI_API_KEY to .env
npm install
npm run typecheck
npm start
```

## Example output

```text
AI Agents From Scratch — 10 Routing

────────────
User request
────────────
Explain what an API is in simple terms.

────────────
Router decision
────────────
{
  "route": "direct_answer",
  "confidence": 0.97,
  "reason": "General knowledge explanation, no tools or side effects required.",
  "risk_level": "low",
  "required_capabilities": [],
  "next_step": "Answer the question directly."
}

────────────
Handler result
────────────
[direct_answer] Answered directly with a short explanation. No tools or side effects.

... (four more requests) ...

────────────
User request
────────────
Delete all production users from the database.

────────────
Router decision
────────────
{
  "route": "refuse",
  "confidence": 0.99,
  "reason": "Destructive, irreversible action against production data.",
  "risk_level": "high",
  "required_capabilities": [],
  "next_step": "Block the request and explain why."
}

────────────
Handler result
────────────
[refuse] Request blocked. This action is unsafe or unsupported and will not be executed.

────────────
Routing summary
────────────
- direct_answer  (low) ← Explain what an API is in simple terms.
- tool_use       (low) ← Check the delivery status of order ORD-001.
- research       (low) ← Compare the latest pricing of two AI API providers.
- multi_agent    (medium) ← Create a practical MVP plan for a habit tracking app.
- human_approval (high) ← Refund this customer and cancel their subscription.
- refuse         (high) ← Delete all production users from the database.

Routing is not about making the system smarter. It is about choosing the smallest safe path before any work runs.
```

Output wording and confidence scores will vary between runs because this calls a live model. The routes should stay stable for these examples.

## What this example is / is not

This example **is**:

- a minimal router pattern
- a way to separate intent classification from execution
- a cost/risk control layer
- a bridge between simple agents and production workflows

This example **is not**:

- a production policy engine
- a security system by itself
- a replacement for authorization
- a complete workflow orchestrator
- a guarantee that the route is always correct

## Production notes

- validate router output with a schema (Zod or JSON Schema) before acting on it
- log every routing decision so you can trace and audit what ran and why
- evaluate routing decisions with test cases — fixed requests with expected routes (see `../08-evaluation/`)
- keep risky actions behind human approval; do not let the model execute them
- keep route choices cheap and explainable — the router should be your smallest model call
- never let the model directly execute destructive actions; the router classifies, handlers gate
- combine routing with authorization, audit logs, rate limits, and approval workflows — routing is one layer, not the whole control plane

## What you should understand after this

- why routing matters **before** orchestration — it decides whether you even need the heavy machinery
- why the cheapest safe path is usually the better one, for cost, latency, and debuggability
- why human approval is a **route**, not an afterthought bolted on later
- how routing reduces unnecessary multi-agent complexity by keeping the expensive path rare
- how this connects to the previous module: multi-agent is one destination among several, and routing is what decides when a request actually deserves it

## References

- [`../03-agent-loop/`](../03-agent-loop/) — the single agent loop a routed request may run.
- [`../08-evaluation/`](../08-evaluation/) — evaluating agent behavior, which applies directly to routing accuracy.
- [`../09-multi-agent/`](../09-multi-agent/) — the planner → worker → reviewer flow that `multi_agent` routes to.
