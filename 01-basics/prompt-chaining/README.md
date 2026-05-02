# Prompt Chaining

Prompt chaining breaks a larger task into smaller model calls where each step uses the previous step's output.

---

## What this demonstrates

- Generating a title, then an outline, then a paragraph
- Passing output from one call into the next call
- Keeping chain steps inspectable
- Making each step separately retryable or replaceable

---

## Why this matters

Many agent workflows are chains before they are loops. Splitting work into steps makes intermediate results visible, which helps you debug, retry, validate, or improve one part without rerunning the whole workflow blindly.

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
Step 1: Generating title...
Title: Why Your AI Agent Keeps Getting Stuck in Infinite Loops

Step 2: Writing outline from title...
Outline:
1. What an infinite loop looks like...

Step 3: Expanding first point into a paragraph...
Paragraph:
An infinite loop in an AI agent happens when...
```

---

## The code, explained

A helper wraps one model call:

```ts
async function complete(prompt: string): Promise<string> {
  const response = await client.chat.completions.create({ ... });
  return response.choices[0].message.content ?? "";
}
```

Then each step passes data forward:

```ts
const title = await complete(`Generate a title about: ${topic}`);
const outline = await complete(`Write an outline for: "${title}"`);
const paragraph = await complete(`Expand this point: ${firstPoint}`);
```

The important engineering move is not the helper function. It is the decision to make the intermediate outputs explicit.

---

## The key insight

Chains trade extra calls for control. You can inspect, retry, and validate each step.

---

## What can go wrong

- Bad output from step 1 poisons step 2.
- Each extra call adds latency and cost.
- Later prompts may need validation around earlier outputs.
- Long chains can become hard to reason about without logs.

---

## Where this shows up in agents

Agents use chains for planning, research summaries, report generation, code review, extraction pipelines, and any workflow where one model step prepares context for the next.

---

## Try it yourself

- Add a validation check after the title step.
- Retry only the outline step with a different prompt.
- Split the paragraph step into two paragraphs and compare quality.
