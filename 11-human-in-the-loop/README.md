# Human-in-the-Loop Approval

> Capability is not permission.

## Why this exists

Module 10 answered *which path should this request take?* The router could send a risky request to a "human approval" lane — but that lane was just a mock handler that printed a message. This module builds the lane for real.

An agent can understand a request, select the correct tool, and produce valid arguments. That is capability. It is not permission. A financial, destructive, externally visible, or irreversible action should not execute just because the model got the tool call right.

So the responsibilities split:

- The **model** proposes an action.
- **Application policy** decides whether that action may execute automatically, needs a human, or is forbidden.
- A **human** can approve, edit, or reject an approval-required action.
- Only after approval does the application **re-validate** the action and execute it — once locally, protected against duplicate runs (not a distributed exactly-once guarantee).

> The agent proposes. The policy gates. The human authorizes. The tool executes.

## The mental model

```text
User request
    ↓
Action Proposal Agent        (model: which tool, what arguments — capability)
    ↓
Zod validation               (reject unknown tools / bad arguments at the boundary)
    ↓
Deterministic policy gate    (application code, not the model)
    ↓
auto_execute | require_approval | deny
    ↓
Persistent approval record   (survives process restarts)
    ↓
Human: approve | edit | reject
    ↓
Re-validate action + policy  (edited arguments are checked again)
    ↓
pending → approved → executed (permission granted before the side effect)
    ↓
Tool execution               (reused if an execution already exists)
    ↓
Audit log                    (durable record of the whole lifecycle)
```

The model owns one box. The application owns every box after it.

## What this module demonstrates

| Policy decision | Meaning | Tools here |
|---|---|---|
| `auto_execute` | Read-only or side-effect-free. Runs without a human. | `getOrderStatus` |
| `require_approval` | Financial, account-changing, or externally visible. Pauses for a human. | `refundOrder`, `cancelSubscription` |
| `deny` | Destructive / forbidden. Never runs, never queued for approval. | `deleteProductionUsers` |

The policy is a plain table in application code. The model never sees it and never decides it.

## Example scenario

The fixed demonstration request is:

> Refund €79.00 for order ORD-001 because the package arrived damaged.

against this mock order:

```ts
{
  orderId: "ORD-001",
  customerId: "CUS-104",
  totalAmount: 79,
  currency: "EUR",
  status: "delivered"
}
```

Step by step:

1. The **Action Proposal Agent** reads the request and proposes a typed `refundOrder({ orderId: "ORD-001", amount: 79, currency: "EUR", reason: "Package arrived damaged" })`. That is the only model call.
2. **Zod validation** confirms the tool is supported and the arguments are well-formed.
3. The **policy gate** classifies `refundOrder` as `require_approval`. Money never moves automatically.
4. A **pending approval record** (`APR-001`) is written to disk. The run prints *"Nothing has executed yet."*
5. A support reviewer decides a **€49 partial refund** is fair after reviewing the case. This is a human business decision, not a model correction. They **edit** the record: `amount` `79 → 49`.
6. The edit is **re-validated** (a negative amount or unknown field would be rejected) and the record stays pending.
7. The reviewer **approves**. The application re-validates the action, re-checks the policy, executes the mock refund **once**, records `EXE-001` / `REF-001`, and moves the record to `executed`.
8. Running approve again **does not** refund a second time — the duplicate is blocked and audited.

## Code walkthrough

- **`index.ts`** — `npm start`. Prints the fixed request, calls the proposal agent, prints the proposal, runs the policy gate, creates the pending record, and confirms nothing executed. The only file that calls the model.
- **`actionAgent.ts`** — `proposeAction(request)`. The single model call. A strict prompt asks for JSON with only `toolName`, `arguments`, and `reason` — it is explicitly forbidden from emitting any permission field. Returns a validated `ActionProposal`.
- **`policy.ts`** — `evaluatePolicy(toolName)`. The deterministic gate: a typed table mapping each tool to `auto_execute | require_approval | deny`. Fails closed — an unclassified tool is denied.
- **`types.ts`** — the contracts. A Zod discriminated union for the proposal, plus schemas for policy decisions, approval records, executions, and audit events.
- **`approvalService.ts`** — the lifecycle orchestration: `handleProposal`, `editApproval`, `approveApproval`, `rejectApproval`, `resetDemo`. Ties the pieces together while keeping each responsibility in its own module.
- **`executor.ts`** — `executeAction`. The last gate before a side effect. Independently defends the boundary: it refuses a `deny` tool, refuses an approval-required tool unless the record is `approved`, and reuses an existing execution for the approval instead of re-running. Otherwise it allocates a persisted execution ID, runs the mock tool, and writes the `ACTION_EXECUTED` audit event.
- **`tools.ts`** — the mock business tools. Every result is marked `mock: true`. `deleteProductionUsers` has no working implementation and throws if called.
- **`approvalStore.ts` / `auditLog.ts`** — JSON-file persistence for approvals, executions, and the audit trail, with deterministic sequential IDs (`APR-001`, `EXE-001`, `REF-001`).
- **`cli.ts`** — the `list / edit / approve / reject / audit / reset` commands.
- **`config.ts` / `utils.ts`** — model + path config, and helpers for validation, JSON stores, IDs, and console formatting.

## Run it

Setup:

```bash
cd 11-human-in-the-loop
cp .env.example .env
# add your OPENAI_API_KEY to .env
npm install
npm run typecheck
npm test
```

Create the proposal (the only step that calls the model):

```bash
npm start
```

List pending approvals:

```bash
npm run approvals
```

Edit the proposed arguments before approval (human business decision):

```bash
npm run edit -- APR-001 --amount=49 --reason="Partial refund approved after review"
```

Approve and execute (once locally; a repeat approval is blocked or reused):

```bash
npm run approve -- APR-001
```

Reject instead (never executes):

```bash
npm run reject -- APR-001 --reason="Customer is not eligible"
```

View the audit log, and reset to a clean demo state:

```bash
npm run audit
npm run reset
```

> Only `npm start` needs an `OPENAI_API_KEY`. Every other command and the whole test suite are model-free.

## Example output

```text
AI Agents From Scratch — 11 Human-in-the-Loop

────────────
User request
────────────
Refund €79.00 for order ORD-001 because the package arrived damaged.

──────────────
Agent proposal
──────────────
{
  "toolName": "refundOrder",
  "arguments": {
    "orderId": "ORD-001",
    "amount": 79,
    "currency": "EUR",
    "reason": "Package arrived damaged"
  },
  "reason": "The refundOrder tool is appropriate for a damaged package."
}

───────────────
Policy decision
───────────────
{
  "decision": "require_approval",
  "reason": "Financial actions cannot execute automatically."
}

──────────────────
Approval requested
──────────────────
Approval APR-001 is pending.
Nothing has executed yet.
```

After editing and approving:

```text
────────────────
Approved APR-001
────────────────
Executed as EXE-001. Mock result:
{
  "refundId": "REF-001",
  "orderId": "ORD-001",
  "amount": 49,
  "currency": "EUR",
  "status": "processed",
  "mock": true
}
```

Approving a second time:

```text
───────────────
Approve APR-001
───────────────
Already executed as EXE-001. Duplicate execution blocked — the tool was not called again.
```

Model wording will vary between runs because `npm start` calls a live model. The tool, the policy decision, and the lifecycle stay stable.

## Why the policy is not decided by the model

The model is good at *understanding* a request and picking a plausible tool. It is the wrong place to decide whether that tool is allowed:

- A prompt is not an enforcement boundary. "You must ask for approval before refunds" is a suggestion the model can be talked out of, or can simply get wrong.
- Permission is an application concern that must be **deterministic, auditable, and testable**. A table in code is all three; a sentence in a prompt is none of them.
- Every object in the proposal schema is `.strict()` at **both** levels — the arguments object and the outer proposal object. Even if the model emits `requiresApproval: false`, the proposal fails validation because unknown top-level fields are rejected. The model literally cannot vote on its own permissions.

That is why `ActionProposal` contains only `toolName`, `arguments`, and `reason` — and never `isAuthorized`, `requiresApproval`, or `allowed`.

## Defense in depth

Approval is enforced twice. The approval service controls the normal workflow, and the executor independently refuses approval-required tools unless the stored record is already `approved`. This prevents a direct executor call — or a loaded/forged pending record — from bypassing the human-review boundary:

- a tool with policy `deny` never executes, anywhere;
- a tool with policy `require_approval` executes only from an `approved` record — a `pending` or `rejected` record is refused inside the executor, not just in the service;
- the forbidden `deleteProductionUsers` tool additionally has no working implementation, so even a bug cannot make it delete anything.

Forbidden proposals are also visible in the trail: a `deny` decision writes an explicit `ACTION_DENIED` audit event and creates **no** approval record and **no** execution record.

## The approval state machine

A record moves through explicit, truthful states:

```text
pending → approved → executed
                 ↘ rejected
```

- **`pending`** — waiting for human review. Not executable.
- **`approved`** — permission has been granted, but the side effect is not yet complete. Permission is persisted *before* the tool runs.
- **`executed`** — the side effect completed and an execution record exists.
- **`rejected`** — execution is permanently blocked for that record; it can never be approved.

The record is only marked `executed` after the tool succeeds. If execution throws, the record truthfully stays `approved` — never falsely `executed`. Auto-executable actions follow the same shape: they are authorized by policy (audited with `authorizedBy: "policy"`) rather than by a human (`authorizedBy: "human"`), but they still go `approved → executed` so a failed run is never recorded as done.

## Approval is not authorization

Human approval in this module is a **workflow pause**, not an identity or access-control system. It answers *"has a human signed off on this specific action?"* — not *"is this the right human, and are they allowed to?"*

A real system still needs, separately: authentication (who is the reviewer), authorization / RBAC (may they approve refunds, and up to what amount), and secure storage of the approval records. This module shows the pause-and-resume shape; it does not replace those layers.

## Idempotency

Approval must not mean "call the tool every time this command runs." The local example prevents repeated execution for the same approval by checking persisted execution records and reusing an existing execution when one is already present:

- the first valid approval executes the tool and moves the record to `executed`;
- approving an already-`executed` record does **not** call the tool again — the duplicate is reported and audited as `DUPLICATE_EXECUTION_BLOCKED`, and the record stays `executed`;
- if an execution record already exists for the approval but the record never advanced to `executed` (for example, the process died between saving the execution and flipping the status), the existing result is reconciled and reused, audited as `EXISTING_EXECUTION_RECOVERED` — the tool is **not** called again.

The execution record is the durable proof that a tool already ran, so this holds across a restart.

This is **not** a distributed exactly-once guarantee. It is local idempotency by approval ID on a single JSON store. Production systems still need downstream idempotency keys, transactions, locking, or durable workflow infrastructure.

## What this example is / is not

This example **is**:

- a minimal human-approval pattern
- a demonstration of model proposal versus application permission
- a pause-and-resume example
- a local persistence and audit example
- a bridge from routing to durable workflows

This example **is not**:

- a complete authorization system
- a production payment system
- a secure approval dashboard
- a durable distributed workflow engine
- a replacement for authentication, RBAC, audit infrastructure, or database transactions
- a guarantee that model-proposed actions are correct

## Production notes

- authenticate reviewers and enforce role-based permissions (who may approve, and up to what limit)
- store approval records and audit logs in a real database with access controls — in a real system they may contain sensitive data
- add approval **expiry** so a stale pending action cannot be approved months later
- handle **concurrency**: two reviewers acting on the same record need locking or optimistic checks
- send **notifications** so pending approvals do not sit unnoticed
- back execution with a real idempotency key against the downstream system, not just a local status flag
- keep the denied tool defended in depth — policy denies it, the executor refuses it, and the tool itself has no implementation
- always show the reviewer the **exact** proposed tool and arguments, and always re-validate edited arguments before executing
- represent money using integer minor units (such as cents) or a dedicated decimal type rather than binary floating-point numbers — this example uses whole euros for readability, which is not safe for real currency arithmetic

## What you should understand after this

- why selecting the correct tool is capability, and permission is a separate, application-owned decision
- why permission belongs in deterministic code, not in a prompt
- why a human must see the exact tool and arguments, and why edited arguments must be re-validated
- why an approved action should run once locally, how a persisted execution record makes that hold across restarts, and why that is still not a distributed exactly-once guarantee
- why approval records and audit logs are the durable spine of a control boundary — and how this sets up durable, resumable workflows

> A correct tool call is still only a proposal until the surrounding system gives it permission to run.

## References

- [`../10-routing/`](../10-routing/) — the router that decides a request needs human approval in the first place.
- [`../08-evaluation/`](../08-evaluation/) — evaluating agent behavior, which applies directly to policy and proposal correctness.
- [`../02-tool-use/`](../02-tool-use/) — where tool calling starts; this module gates the tools it introduced.
