# System vs User Prompt

System prompts define the behavior layer for a model call, while user prompts carry the task, data, or request for that specific turn.

---

## What this demonstrates

- Running the same user question with no system prompt
- Comparing realistic system prompts for engineering, JSON output, and support tone
- Building a `messages` array with optional `system` instructions
- Seeing how role and format instructions change the answer

---

## Why this matters

Real AI products usually need more than "answer this." They need a model to respond as a tutor, support assistant, classifier, JSON API, or constrained workflow step. The system prompt is where you describe that expected behavior, but it is not a security boundary.

---

## Run it

```bash
cp .env.example .env
# add your OPENAI_API_KEY to .env

npm install
npm start
```

---

## Expected output

```text
User prompt:
Explain what an API rate limit is in one short paragraph.
------------------------------------------------------------
Case:
No system prompt

Response:
An API rate limit is a rule that controls how many requests...
------------------------------------------------------------
Case:
JSON-only API responder

Response:
{"concept":"API rate limit","explanation":"...","risk":"...","mitigation":"..."}
```

---

## The code, explained

The user prompt stays the same every time:

```ts
{ role: "user", content: userQuestion }
```

Only the optional system prompt changes:

```ts
{ role: "system", content: example.systemPrompt }
```

That lets you compare behavior separately from the task. The user prompt asks what to do; the system prompt describes how the model should behave while doing it.

---

## The key insight

System prompt = behavior and instruction layer. User prompt = task, data, and request.

---

## What can go wrong

- Vague system prompts create inconsistent behavior.
- Conflicting user prompts can weaken instructions.
- A system prompt can ask for JSON, but your code should still validate the output.
- Do not rely on system prompts alone for security or authorization.

---

## Where this shows up in agents

In agents, the system prompt often defines the agent's role, allowed behavior, constraints, response format, and safety boundaries. Later, tool-use agents also place tool rules and planning constraints here.

---

## Try it yourself

- Add a system prompt that explains the answer to a product manager.
- Ask the JSON responder to include one extra field and compare the output.
- Add a user prompt that requests a conflicting tone and see how stable the system instruction is.
