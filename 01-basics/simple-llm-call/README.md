# Simple LLM Call

The foundation of everything. Before loops, tools, or memory — it's just: send a message, get a response.

---

## What this demonstrates

- How to call the OpenAI API with the `openai` SDK
- The shape of a `chat.completions` request and response
- Reading token usage (input, output) — this is how you get billed
- What `finish_reason` tells you about *why* the model stopped generating

---

## Run it

```bash
cp .env.example .env
# add your OPENAI_API_KEY to .env

npm install
npm start
```

Expected output:

```
Response:
 A large language model is a neural network trained on massive amounts of text
 that learns to predict the next word, and through this simple objective develops
 the ability to understand and generate human language. In practice, you send it
 a string of text and it returns a completion — think of it as a very
 sophisticated autocomplete that can reason and write code.

Token usage:
  Input tokens:  35
  Output tokens: 72
  Stop reason:   stop
```

---

## The code, explained

```ts
const response = await client.chat.completions.create({
  model: "gpt-4o-mini",
  max_tokens: 1024,
  messages: [{ role: "user", content: "..." }],
});
```

**`model`** — which model to use. `gpt-4o-mini` is the sweet spot for learning: capable enough for real tasks, cheap enough to run freely.

**`max_tokens`** — a hard cap on output length. The model stops here even mid-sentence if it hits the limit. Set this intentionally — it directly affects cost and latency.

**`messages`** — an array of turns. Each turn has a `role` (`user`, `assistant`, or `system`) and `content`. A single-turn call like this is the simplest case.

**`response.choices[0].message.content`** — the model's reply. It's an array of choices because OpenAI supports generating multiple candidates (`n > 1`), but you almost always use `[0]`.

**`response.usage`** — `prompt_tokens` and `completion_tokens`. Every token costs money. Get used to reading this.

**`finish_reason`** — `"stop"` means the model finished naturally. `"length"` means you cut it off with `max_tokens`. `"tool_calls"` means it wants to call a tool (covered in 03-tool-use).

---

## The tradeoff

This is a **stateless** call. The model has no memory of previous calls — each request is independent. That's cheap and simple, but it means you have to send the full conversation context every time you want continuity.

That's the core tension in agent design: **context is memory, and memory costs tokens.**

→ [See how this is handled in 04-memory/conversation-history](../../04-memory/conversation-history/)

---

## Where this lives in AgentFlow

Every node in AgentFlow that calls an LLM goes through a thin wrapper around this exact pattern — model selection, token budget, and finish reason handling live in `AgentFlow/apps/worker/src/executors/llm.executor.ts`.
