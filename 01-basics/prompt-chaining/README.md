# Prompt Chaining

The simplest multi-step pattern: take the output of one LLM call and feed it directly as input to the next.

---

## What this demonstrates

- Breaking a complex task into smaller, focused steps
- Passing context forward between calls
- How each step can be independently tuned or swapped
- Why sequential calls give you more control than one long prompt

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
Step 1: Generating title...
Title: Why Your AI Agent Keeps Getting Stuck in Infinite Loops (And How to Fix It)

Step 2: Writing outline from title...
Outline:
 1. What an infinite loop looks like in an agent context ...
 2. The three root causes: missing exit conditions ...
 ...

Step 3: Expanding first point into a paragraph...
Paragraph:
 An infinite loop in an AI agent happens when the agent's reasoning cycle ...
```

---

## The code, explained

The key idea is a simple helper that wraps a single call:

```ts
async function complete(prompt: string): Promise<string> {
  const response = await client.chat.completions.create({ ... });
  return response.choices[0].message.content ?? "";
}
```

Then each step uses the previous output directly:

```ts
const title  = await complete(`Generate a title about: ${topic}`);
const outline = await complete(`Write an outline for: "${title}"`);
const paragraph = await complete(`Expand this point: ${firstPoint}`);
```

Each call is small and focused. The model doesn't have to juggle "generate a title AND an outline AND expand a section" in one go — it just does one thing well.

**Why not just use one big prompt?**

You could write `"Generate a title, then an outline, then expand the first point"` in a single prompt. The problem: you lose control. You can't inspect the intermediate outputs, you can't retry just one step, and the model's attention is split across all three tasks. Chaining keeps each step auditable and replaceable.

---

## The tradeoff

**More calls = more latency and cost.** Each step is a round-trip to the API. For a 3-step chain this is fine; for a 20-step chain, you'll want to think carefully about what actually needs to be sequential vs. what can run in parallel.

**Order matters.** A bad step 1 poisons every step after it. If the title is vague, the outline will be vague. Add validation between steps if quality matters — that's covered in [06-reliability/evaluation](../../06-reliability/evaluation/).

---

## Where this lives in AgentFlow

AgentFlow's pipeline canvas is prompt chaining made visual — each node is a step, and edges define the data flow. The output of one node becomes the input to the next, and you can inspect intermediate values at every connection.
