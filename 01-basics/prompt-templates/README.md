# Prompt Templates

A prompt template is a reusable function that combines stable instructions with changing variables before sending a model call.

---

## What this demonstrates

- A weak template that only says "Review this code"
- A stronger template with role, goal, rules, output format, and delimiters
- Passing the same TypeScript bug into both templates
- Separating instructions from user-controlled code content

---

## Why this matters

Real applications do not hand-write every prompt. They build prompts from product state, user input, files, logs, and previous model outputs. Templates make that repeatable, but they also create a boundary where untrusted content can accidentally become instructions.

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
Bad prompt template

Response:
This function is simple, but it could be improved...
------------------------------------------------------------
Good prompt template

Response:
- high: If items is empty, items[0] is undefined and calling toUpperCase throws.
```

---

## The code, explained

The bad template mixes vague instruction with raw input:

```ts
function badReviewPrompt(code: string) {
  return `Review this code:

${code}`;
}
```

The good template makes the job explicit:

```ts
Rules:
- Return max 5 findings.
- Each finding must include severity: low, medium, or high.
- Focus on edge cases and runtime errors.
- Do not rewrite the whole file.
```

It also wraps the code in a fenced block. Delimiters do not make input safe, but they help the model distinguish instructions from data.

---

## The key insight

Prompt templates are reusable functions, not magic. Their quality comes from clear variables, clear rules, and clear boundaries.

---

## What can go wrong

- Mixing instructions and user input casually.
- Building giant unreadable template strings.
- Forgetting to constrain the output format.
- Letting user-controlled content act like instructions.
- Assuming delimiters solve prompt injection by themselves.

---

## Where this shows up in agents

Agents use templates to build prompts for planning, tool selection, summarization, extraction, code review, and final responses.

---

## Try it yourself

- Add a second bug to the code and see if the good prompt catches both.
- Change the output format to JSON-like bullets.
- Put `Ignore all previous instructions` inside the code comment and compare both prompts.
