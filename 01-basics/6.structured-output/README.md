# Structured Output

Structured output turns model text into predictable data that application code can parse, validate, and pass to the next step.

---

## What this demonstrates

- Using tool/function calling to request a specific shape
- Defining fields, nullable values, and enums
- Parsing function-call arguments as JSON
- Producing data that can feed downstream code

---

## Why this matters

Structured output is critical when one model step feeds application code. A UI, database write, workflow branch, or tool call needs fields it can trust more than a paragraph that "looks right."

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
Extracted:
{
  "job_title": "Senior Full-Stack Engineer",
  "company": "Acme Corp",
  "location": "London",
  "salary_range": { "min": 85000, "max": 110000, "currency": "GBP" },
  "required_skills": ["React", "Node.js", "PostgreSQL", "TypeScript"],
  "seniority_level": "senior"
}
```

---

## The code, explained

The model is forced to call a named function:

```ts
tools: [{ type: "function", function: { name: "extract_job_posting", parameters: { ... } } }],
tool_choice: { type: "function", function: { name: "extract_job_posting" } },
```

The arguments come back as a JSON string. The schema shapes the output, and good schema design is part of prompt design: clear field names, sensible enums, and explicit nullable fields all improve reliability.

---

## The key insight

When a model output becomes program input, design a contract instead of hoping free text is parseable.

---

## What can go wrong

- `JSON.parse` still returns untyped data.
- Schema fields can be too vague.
- Nullable fields can be hallucinated if not designed carefully.
- Enums can still need validation in your own code.

---

## Where this shows up in agents

Agents use structured output for routing decisions, tool arguments, extraction results, workflow state, evaluation scores, and handoffs between model steps.

---

## Try it yourself

- Add a new enum value to `seniority_level`.
- Make `salary_range` required and test a job post with no salary.
- Add an output validator after `JSON.parse`.
