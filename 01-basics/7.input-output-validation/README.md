# Input Output Validation

Validate both sides of an LLM call because the model is not the validator. Your code is the validator.

---

## What this demonstrates

- Rejecting empty user text
- Rejecting text over 500 characters
- Treating user text as untrusted data
- Asking the model for JSON with `summary`, `sentiment`, and `actionRequired`
- Parsing JSON safely and validating it with Zod
- Showing what happens when the model intentionally returns the wrong format

---

## Why this matters

LLM output often flows into tools, APIs, databases, UI components, or workflow decisions. Free text is not a safe contract. Your application needs to reject invalid input before the call and invalid output after the call.

Strong warning: this example does not solve prompt injection. It demonstrates why user-controlled text is dangerous. Real systems must enforce permissions, validate actions, isolate untrusted input, and check outputs in code.

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
Input validation: empty text
Rejected input:
Text cannot be empty.
------------------------------------------------------------
Input validation: oversized text
Rejected input:
Text must be 500 characters or fewer.
------------------------------------------------------------
Output validation: valid JSON request
{
  summary: "The customer likes the product but found setup confusing.",
  sentiment: "neutral",
  actionRequired: true
}
------------------------------------------------------------
Output validation: intentionally broken format
JSON.parse failed: Unexpected token ...
```

---

## The code, explained

Input validation happens before the model call:

```ts
const UserTextSchema = z.string().trim().min(1).max(500);
```

Output validation happens after parsing:

```ts
const AnalysisSchema = z.object({
  summary: z.string(),
  sentiment: z.enum(["positive", "neutral", "negative"]),
  actionRequired: z.boolean(),
});
```

The prompt asks for JSON, but the code still assumes the model might return invalid text.

---

## The key insight

The model can suggest structure. Only your code can enforce structure.

---

## What can go wrong

- `JSON.parse` can fail.
- The model can return markdown fences.
- The model can omit fields.
- The model can invent enum values.
- Prompt injection can appear inside user text.
- Valid JSON can still be semantically unsafe.

---

## Where this shows up in agents

Agents often pass model output into tools, databases, APIs, or workflow steps. Validation prevents free text from becoming unsafe actions.

---

## Try it yourself

- Change `actionRequired` to a string in the schema prompt and watch Zod reject it.
- Ask the model to return markdown fenced JSON and see what `JSON.parse` does.
- Add a second enum value to the prompt but not the schema.
