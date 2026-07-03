# Simple LLM Call

Every agent still starts as one model call: send messages, receive a response, inspect the metadata, and decide what to do next.

---

## What this demonstrates

- Calling the OpenAI API with the `openai` SDK
- Sending a single `user` message
- Reading the model response
- Printing token usage and `finish_reason`

---

## Why this matters

Before tools, memory, planning, or multi-step workflows, an AI product needs a reliable wrapper around one LLM request. That wrapper becomes the foundation for every more advanced agent pattern.

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
Response:
A large language model is a neural network trained on massive amounts of text...

Token usage:
  Input tokens:  35
  Output tokens: 72
  Stop reason:   stop
```

---

## The code, explained

The core call is small:

```ts
const response = await client.chat.completions.create({
  model: "gpt-4o-mini",
  max_tokens: 1024,
  messages: [{ role: "user", content: "..." }],
});
```

`messages` contains the input. `response.choices[0].message.content` contains the answer. `response.usage` shows token counts. `finish_reason` tells you whether the model stopped naturally or hit a limit.

---

## The key insight

An agent is not magic wrapped around a model. It is application code that repeatedly makes model calls and decides what to do with the results.

---

## What can go wrong

- Missing API keys cause auth errors.
- Too-low `max_tokens` can truncate the answer.
- Ignoring token usage hides cost and latency.
- Treating one response as guaranteed truth leads to brittle products.

---

## Where this shows up in agents

Every planning step, tool decision, summary, extraction, and final answer in an agent eventually comes back to this basic request/response pattern.

---

## Try it yourself

- Change the user prompt to a technical explanation.
- Lower `max_tokens` to force a cutoff.
- Print the full `response.choices[0]` object to inspect metadata.
