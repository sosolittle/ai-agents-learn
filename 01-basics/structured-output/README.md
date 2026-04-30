# Structured Output

Getting reliable, typed data back from an LLM — no parsing hacks, no regex, no "hope it returns JSON."

---

## What this demonstrates

- Using tool / function calling to enforce a specific output shape
- Defining a schema once and using it for both the API call and TypeScript types
- Why `tool_choice: forced` is more reliable than `"respond in JSON"` in the system prompt
- Handling nullable fields and enums in the schema

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

The trick is forcing the model to call a function rather than returning free text:

```ts
tools: [{ type: "function", function: { name: "extract_job_posting", parameters: { ... } } }],
tool_choice: { type: "function", function: { name: "extract_job_posting" } },
```

`tool_choice` set to a specific function name tells the model: *don't generate a text reply, call this function with arguments that match the schema.* The arguments come back as a JSON string you can `JSON.parse` directly.

**Why not just say "respond in JSON" in the prompt?**

The model usually will — but "usually" isn't good enough in production. Without a schema, it might add extra keys, omit nullable fields, use different casing, or wrap the JSON in a markdown code block. Tool calling gives you a contract the model is trained to respect.

**Nullable fields:**

```ts
salary_range: {
  type: ["object", "null"],
  ...
}
```

Some job posts don't list salary. Marking the field as `object | null` teaches the model to return `null` rather than hallucinate a number.

**Enums:**

```ts
seniority_level: {
  type: "string",
  enum: ["junior", "mid", "senior", "lead", "unknown"],
}
```

Constrain the model to a fixed set of values. Without this, it might return `"Senior"`, `"Sr."`, `"senior-level"` — all different strings, all meaning the same thing.

---

## The tradeoff

**Schema design is prompt design.** A vague field name like `level` will produce inconsistent results. A specific name like `seniority_level` with a clear enum produces consistent ones. Time spent on the schema pays back in reliability.

**This still isn't a type-safe guarantee.** `JSON.parse` returns `any`, and the model could technically return arguments that don't fully match your schema. For critical paths, validate with a library like [zod](https://github.com/colinhacks/zod) after parsing.

---

## Where this lives in AgentFlow

Every AgentFlow node that produces output for downstream nodes uses this pattern under the hood — structured output is how one node communicates with the next in a typed, predictable way.
