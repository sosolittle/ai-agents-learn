# Agent Evaluation

> Normal code has tests. Tool-calling agents need evals.

## Start here

```bash
cp .env.example .env
# add your OPENAI_API_KEY to .env
npm install
npm start
```

## Why this exists

In normal software engineering, we do not trust code because it worked once. We write tests and run them repeatedly. Agents need the same testing mindset.

For tool-calling agents, checking only the final answer is incomplete. A tool-calling agent can give a good-looking answer while:

- calling the wrong tool
- passing the wrong ID
- ignoring a failed tool result
- taking too many steps
- inventing a fact
- pretending an unsafe action happened

## What we evaluate

| Layer | What we check | Why |
|---|---|---|
| Final answer | Contains required information | User-facing correctness |
| Tool selection | Correct tools were called | Avoids wrong backend behavior |
| Tool arguments | Correct IDs/parameters passed | Prevents subtle system bugs |
| Forbidden tools | Unsafe actions were avoided | Safety boundary |
| Iterations | Finished within limits | Cost/reliability |
| Grounding | Answer uses tool results | Reduces hallucination |

## The mental model

```text
Normal test: input → function → output assertion

Agent eval: user goal → agent loop → trace + final answer → behavior assertions
```

## How it works

```text
eval case
  ↓
run agent
  ↓
record trace
  ↓
run deterministic checks
  ↓
optional LLM judge
  ↓
print pass/fail report
```

The mock customer-support agent can look up orders and inventory. It records every decision, tool call, tool result, error, final answer, and stop reason as data. The evaluator then checks that behavior against five small cases.

## Deterministic checks vs LLM judge

Deterministic checks are for facts visible in the trace: whether a tool was called, whether its arguments matched, whether a forbidden tool was avoided, and whether the loop stopped in time.

The optional LLM judge is for fuzzy answer quality: whether the answer is grounded, explains uncertainty, or covers every part of the request. The judge can be wrong. It should never be the only evaluator.

Use deterministic checks for facts you can verify from the trace. Use an LLM judge only for fuzzy answer-quality checks.

## What this is not

- Not a production eval framework.
- Not a replacement for observability.
- Not a guarantee of safety.
- Not a benchmark.
- Just the core pattern from scratch.

## Next steps

- Add more eval cases.
- Save golden traces.
- Run evals in CI.
- Track cost and latency.
- Compare prompts and models.
- Add human approval for risky actions.
