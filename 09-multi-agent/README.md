# Multi-Agent Collaboration

> One agent is not always enough. Some tasks are clearer when agents have separate responsibilities.

## Why this exists

A single agent can plan, execute, and review in one prompt. That works, but it mixes three different jobs into one set of instructions, and those jobs pull in different directions. The part that plans wants to stay broad. The part that executes wants concrete detail. The part that reviews needs to be skeptical of work it just produced.

Multi-agent design is useful when a task benefits from that role separation. Instead of one prompt doing everything, you give each responsibility to a smaller agent with a narrow job and an explicit output.

The point is not "agents talking to each other." The point is **controlled handoffs**:

- a **planner** decides what needs to be done
- a **worker** produces the draft
- a **reviewer** checks the draft against the plan
- each stage has an explicit, structured output (a contract)
- the **review happens before** the final answer is shown

Multi-agent systems are not magic. They are structured handoffs between smaller agents with clear responsibilities.

## The mental model

```text
User goal
   ↓
Planner Agent
   ↓
Worker Agent
   ↓
Reviewer Agent
   ↓
Final Answer
```

- **Planner** decides what needs to be done and writes it as a structured plan.
- **Worker** creates the draft, grounded in the plan and local knowledge.
- **Reviewer** checks whether the draft actually satisfies the plan.
- **Final answer** is produced only after the review, based on its outcome.

Each arrow is a handoff. Each box has one job. The data passed across each arrow is a typed object, not a free-form chat message.

## Where you already see this pattern

- coding agents that plan a change, edit code, and review the diff
- research agents that search, synthesize, and then fact-check
- workflow agents that route tasks across specialized systems
- product assistants that separate planning from final recommendation
- support agents that escalate to a specialist agent for hard cases

The shared idea: split a job into roles with clear boundaries, and pass a defined output between them.

## What this module demonstrates

| Layer | Responsibility | Output |
|---|---|---|
| Planner | Break down the goal | Structured plan |
| Worker | Produce draft using local knowledge | MVP draft |
| Reviewer | Check draft against plan | Pass/fail review |
| Final step | Decide what to show | Final answer or feedback |

## Example scenario

A mock software project planning assistant.

**User goal:**

> "I want to build a small habit tracking app. Give me a practical MVP plan."

The stages:

1. **Planner** turns that one sentence into a structured plan: the objective, the user type, must-have vs nice-to-have features, technical constraints, risks, and acceptance criteria.
2. **Worker** takes the plan plus a small local knowledge base and produces an MVP draft: product scope, data model, API endpoints, frontend screens, a development sequence, and tradeoffs.
3. **Reviewer** checks the draft against the plan and the original goal, then returns a pass/fail review with missing items, risky claims, and improvement notes.
4. **Final step** prints the approved plan, or the draft plus reviewer feedback if revisions were requested.

## Code walkthrough

- **`index.ts`** — the orchestrator. Defines the goal, runs planner → worker → reviewer in sequence, prints each stage, and decides what to show based on the review. This is where the handoffs are wired together.
- **`agents/plannerAgent.ts`** — `runPlannerAgent(goal)`. Turns the goal into a structured `PlannerOutput`. Does not write the final answer.
- **`agents/workerAgent.ts`** — `runWorkerAgent(goal, plan)`. Produces a grounded `WorkerDraft` using the plan and the local knowledge base.
- **`agents/reviewerAgent.ts`** — `runReviewerAgent(goal, plan, draft)`. Returns a `ReviewResult`: pass/fail plus structured feedback. It judges; it does not rewrite.
- **`knowledge.ts`** — a small mock knowledge base (recommended features, stack, risks, example endpoints and data model). This grounds the worker so it builds on local context instead of inventing everything.
- **`types.ts`** — the shared contracts: `PlannerOutput`, `WorkerDraft`, `ReviewResult`, `AgentStep`, and `MultiAgentRunResult`. These types are the handoff agreements between stages.
- **`utils.ts`** — `safeJsonParse`, `printSection`, and a small JSON pretty-printer. The JSON parsing is defensive: invalid JSON throws a clear, labelled error.

## Run it

```bash
cd 09-multi-agent
cp .env.example .env
# add your OPENAI_API_KEY to .env
npm install
npm run typecheck
npm start
```

## Example output

```text
AI Agents From Scratch — 09 Multi-Agent

────────────
User goal
────────────
I want to build a small habit tracking app. Give me a practical MVP plan.

────────────
Planner output
────────────
{
  "objective": "Build an MVP habit tracking app",
  "user_type": "Individuals who want to build and track daily habits",
  "must_have_features": ["create a habit", "mark a habit complete", "view streaks"],
  "nice_to_have_features": ["reminders", "weekly summary"],
  "technical_constraints": ["small scope", "single user to start"],
  "risks": ["scope creep", "timezone bugs in streak logic"],
  "acceptance_criteria": ["a user can create a habit and mark it done for today"]
}

────────────
Worker draft
────────────
{
  "product_scope": "Single-user habit tracker covering create, check-in, and streaks",
  "data_model": ["User", "Habit", "CheckIn"],
  "api_endpoints": ["POST /habits", "GET /habits", "POST /habits/:id/checkins"],
  "frontend_screens": ["Today", "Habit detail", "Add habit"],
  "development_sequence": ["data model", "API", "screens", "streak logic"],
  "tradeoffs": ["no auth in v1 keeps scope small but is single-user only"]
}

────────────
Reviewer result
────────────
{
  "passed": true,
  "missing_items": [],
  "risky_claims": [],
  "improvement_notes": ["call out timezone handling for streaks explicitly"],
  "final_recommendation": "approve"
}

────────────
Final answer
────────────
✅ Reviewer approved the draft. Final MVP plan:
...

Multi-agent systems are not magic. They are structured handoffs: planner → worker → reviewer → final answer.
```

Output wording will vary between runs because this calls a live model. The structure of the flow stays the same.

## What this example is / is not

This example **is**:

- a minimal multi-agent handoff pattern
- a role-separation demo
- a way to understand planner-worker-reviewer architecture

This example **is not**:

- a production multi-agent framework
- a swarm
- an autonomous team of agents
- a replacement for workflow orchestration
- a guarantee of correctness

## Production notes

- validate each agent's output with a schema (Zod or JSON Schema) at the boundary
- log every handoff so you can trace which agent produced what
- keep agent roles narrow — one job per agent
- define explicit contracts between agents (the typed outputs here)
- add evals for each stage, not just the final answer (see `../08-evaluation/`)
- avoid unlimited recursive agent loops; cap retries and iterations
- do not let every agent call every tool — scope tools to roles
- use human approval for risky or irreversible actions

## What you should understand after this

- why role separation can make agents easier to reason about
- how handoffs work, and why the data crossing them should be a defined contract
- why each agent should have a narrow job
- why a reviewer agent reduces risk but is **not** a safety guarantee
- how multi-agent systems relate to workflow orchestration: this is structured control flow, not autonomy

## References

- [`../03-agent-loop/`](../03-agent-loop/) — the single agent loop these roles are built from.
- [`../07-reliability-observability/`](../07-reliability-observability/) — tracing and debugging the steps each agent takes.
- [`../08-evaluation/`](../08-evaluation/) — evaluating agent behavior, which you can apply to each stage here.
