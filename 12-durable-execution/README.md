# Durable Execution

> Agent memory remembers the conversation. Durable state remembers what actually happened.

## Why this exists

Module 11 ended with a human-approved refund. But approval is not the end of the engineering problem. Suppose the refund succeeds and the process crashes one millisecond later, before the workflow records the step as complete. On restart, the runtime sees an incomplete refund step. Should it run it again?

"Just retry it" becomes dangerous once workflow steps have side effects. A refund that runs twice is not a retried refund — it's two refunds. The same shape shows up anywhere an agent (or any backend process) triggers a real action: sending an email, creating a ticket, charging a card, provisioning a resource. A crash between "the side effect succeeded" and "the workflow recorded that" is not a hypothetical edge case — it is the normal failure mode of any process that can be killed mid-step.

This module builds the two mechanisms that make retrying safe:

- **Checkpointing** — persisting where the workflow got to, so a restart doesn't start over from scratch.
- **Idempotency** — a key that lets a retried side effect recognize it already happened, so the retry doesn't repeat it.

> Checkpointing tells the workflow where it was. Idempotency tells the side effect it already ran.

## The mental model

```text
Approved action
      ↓
validate_approval
      ↓
execute_refund
      ↓
checkpoint
      ↓
send_confirmation
      ↓
complete
```

The failure window this module exists to demonstrate:

```text
execute_refund
      ↓
REF-001 created by the mock provider
      ↓
💥 crash
      ↓
checkpoint never happened
```

And resume:

```text
restart
   ↓
load checkpoint (completedSteps: [validate_approval])
   ↓
execute_refund appears incomplete
   ↓
retry with the same idempotency key: WF-001:execute_refund
   ↓
mock provider recognizes the key, returns the existing REF-001
   ↓
checkpoint execute_refund as completed
   ↓
continue to send_confirmation
```

## Checkpointing vs idempotency

This is the core distinction the module is built to make obvious — it is easy to believe checkpointing alone is enough, and it isn't.

| Mechanism | Question it answers |
|---|---|
| Checkpoint | Where did the workflow get to? |
| Idempotency | If this step is retried, can it avoid repeating the side effect? |

Neither replaces the other. A workflow that only checkpoints can still double-refund: the crash in this module happens **after** the side effect and **before** the checkpoint, so on resume the workflow correctly identifies `execute_refund` as "not done yet" — and a naive implementation would call the refund tool again. A workflow that only has idempotent side effects but never checkpoints doesn't know where to resume from at all. Both are needed, and they solve different halves of the problem.

## Example scenario

Continuing directly from [`../11-human-in-the-loop/`](../11-human-in-the-loop/), the input to this module is the refund a human already approved there:

```json
{
  "approvalId": "APR-001",
  "status": "approved",
  "toolName": "refundOrder",
  "arguments": {
    "orderId": "ORD-001",
    "amount": 49,
    "currency": "EUR",
    "reason": "Partial refund approved after review"
  }
}
```

Module 11 answered *should this action be allowed to execute?* This module starts after that question is already settled and asks a different one: *once execution starts, how does the workflow survive failure safely?* This module does not reimplement approval, policy, or audit — it treats the approved action as validated input from the previous control layer and re-checks only what it needs to (see [Idempotency](#idempotency) and `validate_approval` below).

## The dangerous failure window

```text
refund succeeds
      ↓
application crashes
      ↓
workflow checkpoint never updates
```

At this exact point, the persisted workflow still believes:

```text
completedSteps: [validate_approval]
next incomplete step: execute_refund
```

But the mock provider's ledger already contains:

```text
WF-001:execute_refund → REF-001
```

This is the gap where a naive "just re-run the incomplete step" retry would create `REF-002` and refund the customer twice. Nothing in the checkpoint alone prevents that — only the idempotency key does.

## Workflow state

The persisted checkpoint right after the crash, before resume:

```json
{
  "id": "WF-001",
  "status": "running",
  "input": {
    "approvalId": "APR-001",
    "approvalStatus": "approved",
    "toolName": "refundOrder",
    "orderId": "ORD-001",
    "amount": 49,
    "currency": "EUR",
    "reason": "Partial refund approved after review"
  },
  "completedSteps": ["validate_approval"],
  "context": {},
  "createdAt": "...",
  "updatedAt": "..."
}
```

Notice `status` is still `"running"` — not some fabricated `"crashed"` value. A real abrupt crash never gets the chance to persist anything; the truthful last-known state is whatever it was before the crash happened.

## Idempotency ledger

The mock refund provider's own record, independent of the workflow checkpoint:

```json
{
  "key": "WF-001:execute_refund",
  "workflowId": "WF-001",
  "step": "execute_refund",
  "type": "refund",
  "result": {
    "refundId": "REF-001",
    "orderId": "ORD-001",
    "amount": 49,
    "currency": "EUR",
    "status": "processed",
    "mock": true
  },
  "createdAt": "..."
}
```

The idempotency key (`WF-001:execute_refund`) is checked **inside the provider function itself** (`mockRefundProvider` in `steps.ts`) — not by wrapping the call in `if (!completedSteps.includes(...))` in the runner. That distinction matters: the runner's own bookkeeping is exactly what the crash corrupted. The idempotency check has to live somewhere the crash can't invalidate it — at the boundary where the side effect actually happens.

## What happens after restart

1. The runner reloads `WF-001` from disk. Nothing from the pre-crash run is reused in memory — `resumeWorkflow` calls `findWorkflow` itself.
2. `completedSteps` says `execute_refund` has not finished, so the runner calls it again.
3. `mockRefundProvider` is called with the same idempotency key, `WF-001:execute_refund`. It finds the existing ledger entry and returns `REF-001` — `reused: true`. No `REF-002` is created.
4. The runner checkpoints `execute_refund` as completed, now that the result (old or new) is known.
5. `send_confirmation` runs normally, creates `MSG-001`, and checkpoints.
6. The workflow is marked `completed`.

Final counts: **1 refund effect, 1 confirmation effect** — regardless of the crash in between.

## Code walkthrough

- **`types.ts`** — Zod contracts: the closed `WorkflowStep` enum (and the `WORKFLOW_STEPS` array derived from it, so step order has one source of truth), workflow status, the structural `ApprovedAction`/`WorkflowInput` shapes, the persisted `WorkflowRecord`, the discriminated `EffectRecord` union, and workflow events.
- **`steps.ts`** — the actual step implementations. `validateApproval` is pure and side-effect free; it applies the *business-rule* schema (regex IDs, positive amount, `EUR` only, non-empty reason) — stricter than the structural schema in `types.ts`, which only proves "these fields exist." `mockRefundProvider` and `mockConfirmationProvider` are the idempotent side-effect boundaries: each checks the ledger for its idempotency key before doing anything.
- **`workflowRunner.ts`** — orchestration and resume semantics. `createWorkflow`, `runWorkflow`, `resumeWorkflow`. Resume position is always derived as "the first step not in `completedSteps`" — there is no separately tracked `currentStep` pointer that could drift out of sync with the array that actually matters. This file also defines `SimulatedCrashError` and the `crashAfterSideEffectStep` injection point.
- **`checkpointStore.ts`** — JSON persistence for workflow records: "where did the workflow get to?"
- **`effectStore.ts`** — JSON persistence for the idempotency ledger, plus the `idempotencyKey(workflowId, step)` helper: "if this step retries, can it avoid repeating the side effect?"
- **`eventLog.ts`** — an append-only, validated event log for lifecycle visibility (`WORKFLOW_CREATED`, `STEP_STARTED`, `SIDE_EFFECT_REUSED`, ...).
- **`index.ts`** — `npm start`. The full readable crash/resume demonstration in one file. No model call.
- **`cli.ts`** — manual commands: `crash`, `resume`, `status`, `effects`, `events`, `reset`.
- **`config.ts` / `utils.ts`** — data paths and small helpers (JSON store I/O, ID generation, console formatting).

## Run it

```bash
cd 12-durable-execution
npm install
npm run typecheck
npm test
npm start
```

No `.env` file and no API key are needed anywhere in this module — see [No model call is required](#no-model-call-is-required).

## Manual crash/resume

```bash
npm run reset
npm run crash
npm run status -- WF-001
npm run effects
npm run resume -- WF-001
npm run status -- WF-001
npm run events -- WF-001
```

`npm run crash` runs only the first half of the story: it creates a fresh workflow and deliberately stops in the dangerous window, right after the refund side effect succeeds and right before it is checkpointed. `npm run resume -- WF-001` represents a fresh process picking the workflow back up — it reloads the record from disk, exactly like `resumeWorkflow` does internally.

## Example output

`npm start`:

```text
AI Agents From Scratch — 12 Durable Execution

───────────────
Approved action
───────────────
{
  "approvalId": "APR-001",
  "status": "approved",
  "toolName": "refundOrder",
  "arguments": {
    "orderId": "ORD-001",
    "amount": 49,
    "currency": "EUR",
    "reason": "Partial refund approved after review"
  }
}

This is where Module 12 begins — after the model proposed a refund and a human already approved it in Module 11. There is no model call in this module.

────────────────
Workflow created
────────────────
WF-001

──────────────────────────
💥 Simulated process crash
──────────────────────────
Simulated process crash after the side effect for "execute_refund" succeeded, before the checkpoint for that step was saved.

The refund succeeded, but execute_refund was NOT checkpointed.

───────────────────────────────
Persisted state after the crash
───────────────────────────────
✓ validate_approval
○ execute_refund
○ send_confirmation

──────────────────
Side-effect ledger
──────────────────
WF-001:execute_refund → REF-001

─────────────────
Process restarted
─────────────────
Reloading WF-001 from persisted state...
Resuming from: execute_refund

──────────────────
Workflow completed
──────────────────
WF-001  [completed]

Refund effects:       1
Confirmation effects: 1

────────────
Lesson
────────────
The checkpoint remembers where the workflow was.
The idempotency key prevents a replayed step from repeating the side effect.
```

`npm run events -- WF-001` after `crash` then `resume`:

```text
WORKFLOW_CREATED
WORKFLOW_STARTED
STEP_STARTED              validate_approval
STEP_COMPLETED             validate_approval
STEP_STARTED              execute_refund
SIDE_EFFECT_EXECUTED       execute_refund
WORKFLOW_RESUMED
STEP_STARTED              execute_refund
SIDE_EFFECT_REUSED         execute_refund
STEP_COMPLETED             execute_refund
STEP_STARTED              send_confirmation
SIDE_EFFECT_EXECUTED       send_confirmation
STEP_COMPLETED             send_confirmation
WORKFLOW_COMPLETED
```

(trailing whitespace on lines with no step name is trimmed above for readability; the real output pads every line to the same column.)

Running `npm run resume -- WF-001` again afterward:

```text
─────────────
Resume WF-001
─────────────
Workflow WF-001 is already complete. Nothing to resume.
```

## No model call is required

There is no model call in this module. The interesting problem begins after the model has already proposed an action and the surrounding system has authorized it. Durable execution belongs to the application runtime, not the prompt. This module makes zero OpenAI API calls, needs no API key, and every command — including `npm start` — runs the same offline.

## Why not just start again?

Pure steps are often safe to recompute: `validate_approval` reads no external state and changes nothing, so running it again on resume costs nothing and produces the same answer. Side-effecting steps are different — `execute_refund` and `send_confirmation` reach outside the process, and "just run the incomplete step again" is exactly the naive retry that would create a second refund. The two step kinds need different resume strategies, and this module treats them differently: pure steps just re-run; side-effecting steps re-run through an idempotency check.

## Agent memory vs workflow state

Conversation memory (Module 6) can know: *"the customer requested a refund."* That is a fact about what was said. Durable workflow state has to know something stronger: *`REF-001` was actually created, by this workflow, for this order.* A summary of the conversation cannot answer "did the refund actually happen" after a crash — only a persisted, idempotent record of the side effect can. Those are not interchangeable, and conflating them is exactly what lets a workflow "remember" a refund happened when it never did, or double-refund because it forgot one already did.

## Checkpoint boundaries

The runner checkpoints a step **only** after that step's work has fully succeeded — never before, and never speculatively. That is deliberate: a checkpoint written before the side effect completes could mark `execute_refund` done when the refund never actually happened. But checkpointing strictly after success still leaves a window: between "the side effect returned" and "the checkpoint write completed," the process can die, and the checkpoint never happens. That window is the entire reason this module exists. Checkpointing correctly does not close it — only idempotency at the side-effect boundary does.

## Idempotency

The idempotency key is derived from the workflow, not chosen arbitrarily:

```text
WF-001:execute_refund
WF-001:send_confirmation
```

Because the key is workflow-specific, two different workflows retrying the "same" step never collide (`WF-001:execute_refund` and `WF-002:execute_refund` are independent). Because it's stable across retries of the *same* workflow and step, a replay finds the original result instead of creating a new one. A real payment provider, email provider, or job system should ideally accept the same kind of caller-supplied idempotency key on its own end — that is what makes the guarantee hold even if this process's local ledger were somehow lost.

**This is not exactly-once execution.** It is local duplicate protection using a persisted idempotency key, checked at the side-effect boundary — a narrower, more honest claim.

## State machine

```text
running → completed
     ↘ failed
```

- **`running`** — some steps may be checkpointed, the rest are not yet done. This is also what a workflow looks like immediately after a crash: nothing marks it as crashed, because the process disappeared before it had any chance to persist that.
- **`completed`** — every step checkpointed. Resuming a completed workflow is a no-op; no side effect runs again.
- **`failed`** — a real step error (invalid approval, unsupported currency, an order that doesn't exist) that the *running* process was alive to catch and persist. This is different in kind from a simulated crash: a crash never reaches the code that would mark a workflow failed, because the process is gone. A failure is the application choosing to record "this cannot proceed"; a crash is the application not existing anymore to choose anything.

## What this example is

- a checkpointed workflow that survives a simulated process crash
- a resume-from-persisted-state example, reloaded fresh from disk
- an explicit demonstration of the failure window between a side effect and its checkpoint
- a local idempotency example, enforced at the side-effect boundary rather than in the caller
- a bridge from human approval (Module 11) to workflow orchestration

## What this example is not

- a distributed workflow engine
- a guarantee of true exactly-once execution
- a database-backed job system
- a transactional payment system
- a source of distributed locking
- provider-level production idempotency (the mock providers here are local and in-process)
- a system with workflow schema/version migration
- a replacement for Temporal, durable task platforms, or similar durable-execution frameworks
- production-grade storage (it's JSON files, for readability and zero setup)

## Production notes

A production version of this pattern would additionally need:

- database-backed workflow state instead of JSON files, with transactional state transitions
- downstream idempotency keys accepted by the *actual* payment/email/job provider, not just a local mock
- a transactional outbox so "side effect happened" and "checkpoint written" can't diverge as easily
- retries with backoff, and a dead-letter path for steps that keep failing
- leases or worker ownership, so two workers can't both think they own the same workflow
- heartbeats and workflow timeouts, to detect a worker that died without ever throwing
- concurrency control: locking or optimistic concurrency on workflow records
- step attempt counters, to distinguish "retried once" from "stuck in a retry loop"
- an immutable, durable event history (this module's event log is a JSON file, not a durable event store)
- observability: metrics and alerting on stuck or failed workflows
- careful handling of what side-effect data gets persisted (no secrets, no unnecessary PII)
- recovery ownership after a worker process dies mid-step, in a multi-worker deployment

## What you should understand after this

- conversation memory is not workflow state — one describes what was said, the other proves what happened
- checkpoints let a workflow resume from where it was, instead of restarting from zero
- checkpointing alone does not prevent duplicated side effects — the crash in this module happens specifically in the gap checkpointing cannot close
- side-effecting steps need idempotency at the boundary where the effect actually happens, not just a guard in the caller
- retries are only safe when the repeated operation is itself safe to repeat — pure steps and side-effecting steps need different resume strategies
- persisted workflow identity (a stable ID, a stable idempotency key derived from it) is what makes recovery possible at all
- failure recovery has to be designed into a workflow from the start, not patched on after a production incident

> A durable agent system does not only know what it wanted to do. It knows what already happened.

## References

- [`../11-human-in-the-loop/`](../11-human-in-the-loop/) — the approval boundary this module picks up right after. Read this first; Module 12 does not re-explain policy, approval, or audit.
- [`../07-reliability-observability/`](../07-reliability-observability/) — step-level traces and retry visibility for agent loops; the event log here plays the same role for a workflow.
- [`../03-agent-loop/`](../03-agent-loop/) — where the idea of a multi-step loop with its own state first shows up, before durability was a concern.
