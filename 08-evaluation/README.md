# Agent Evaluation

> Normal code has tests. Tool-calling agents need evals.

## Why this exists

In normal software engineering, we do not trust code because it worked once. We write tests and run them repeatedly.

Tool-calling agents need the same testing mindset. But the final answer is only one layer. An agent can produce a convincing reply while:

- calling the wrong tool
- passing the wrong ID
- ignoring a failed tool result
- taking too many steps
- inventing a fact
- claiming an unsafe action happened

If you only check the last message, you miss the behavior that produced it.

## Where you already see this pattern

This matters anywhere a model can do more than generate text:

- customer-support agents that call order, inventory, refund, or account tools
- research agents that search, read pages, and synthesize answers
- coding agents that read files, run tests, edit code, and retry
- workflow agents that call APIs across multiple systems
- internal business assistants that use CRM, calendar, database, or ticketing tools

The common thread is simple: once the model can call tools, the behavior path matters - not only the final message.

## The mental model

```text
Normal test: input → function → output assertion

Agent eval: user goal → agent loop → trace + final answer → behavior assertions
```

Normal tests usually check the output. Agent evals check the output **and** the path the agent took to get there.

That path lives in the trace: model decisions, tool calls, arguments, results, errors, completion, and stop reason. The trace is part of the behavior.

## What we evaluate

| Layer | What we check | Why |
|---|---|---|
| Final answer | Contains required information | User-facing correctness |
| Tool selection | Correct tools were called | Avoids wrong backend behavior |
| Tool arguments | Correct IDs/parameters passed | Prevents subtle system bugs |
| Forbidden tools | Unsafe actions were avoided | Safety boundary |
| Iterations | Finished within limits | Cost/reliability |
| Grounding | Answer uses tool results | Reduces hallucination |

For tool-calling agents, the trace is not just debugging output. It is evidence of what the agent actually did.

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

This module uses a small mock order-support agent with three safe tools:

- `getOrderStatus(orderId)` looks up an order
- `checkInventory(productName)` checks stock
- `finalAnswer(content)` returns the complete response and ends the run

`finalAnswer` is a terminal tool. It is included in the trace because completion is also part of the agent's behavior.

Destructive actions such as deleting orders are not exposed as tools. The eval cases still check that forbidden tools were not called, because the absence of unsafe behavior is something worth testing explicitly.

## Deterministic checks vs LLM judge

Most checks in this module are deterministic. If a fact is visible in the trace, inspect it directly.

Deterministic checks are good for:

- expected tool was called
- tool arguments matched
- forbidden tool was avoided
- max iterations were respected
- final answer contains key factual tokens

The optional LLM judge is useful for fuzzier questions:

- answer is grounded in the tool result
- answer covers every part of the request
- answer refuses an unsafe request clearly
- answer does not invent facts when wording varies

The judge can be wrong. It should never be the only evaluator. Deterministic checks should carry the core pass/fail logic.

Use deterministic checks for facts you can verify from the trace. Use an LLM judge only for fuzzy answer-quality checks.

## Example output

```text
AI Agents From Scratch — 08 Evaluation

Running 5 eval cases...

✅ Looks up a shipped order
   ✅ called expected tool getOrderStatus
   ✅ getOrderStatus args matched {"orderId":"ORD-001"}
   ✅ final answer contained "TRK-789"
   ✅ did not call forbidden tool deleteOrder
   🤖 judge: 0.90 — grounded in tool result

✅ Checks inventory
   ✅ called expected tool checkInventory
   ✅ checkInventory args matched {"productName":"Wireless Headphones"}
   ✅ final answer contained "Wireless Headphones"
   ✅ final answer contained at least one of: in stock, available, 12

Summary: 5/5 passed
Final answers are only one layer. For tool-calling agents, the trace is part of the behavior.
```

## Setup

This module is standalone. Run it from inside `08-evaluation`:

```bash
cp .env.example .env
# add your OPENAI_API_KEY to .env
npm install
npm start
```

## A note on variability

This module calls a live language model, so final wording can vary slightly between runs. The deterministic checks focus on stable behavior: tool selection, tool arguments, forbidden tools, stop reason, and key factual tokens.

## What this is not

- Not a production eval framework.
- Not a benchmark.
- Not a guarantee of safety.
- Not a replacement for observability.
- Just the core pattern from scratch.

## References

- [AgentBench: Evaluating LLMs as Agents](https://arxiv.org/abs/2308.03688) - evaluates LLMs as agents in interactive, multi-turn environments.
- [TRAJECT-Bench: A Trajectory-Aware Benchmark for Evaluating Agentic Tool Use](https://arxiv.org/abs/2510.04550) - focuses on tool-use trajectories, including tool selection, argument correctness, and ordering.
- [Beyond the Final Answer: Evaluating the Reasoning Trajectories of Tool-Augmented Agents](https://arxiv.org/abs/2510.02837) - argues that agent evaluation should go beyond final-answer matching and assess trajectory behavior.

## Next steps

- Add more eval cases.
- Save golden traces.
- Add regression snapshots for tool-call traces.
- Run evals in CI.
- Track cost and latency.
- Compare prompts and models.
- Add human approval for risky actions.
