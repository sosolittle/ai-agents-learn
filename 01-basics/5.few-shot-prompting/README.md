# Few-Shot Prompting

Few-shot prompting gives the model examples in the context window so it can copy a pattern for the current task.

---

## What this demonstrates

- Classifying support tickets with zero-shot instructions
- Adding few-shot examples for business-specific priority rules
- Handling ambiguous messages that mention both money and technical issues
- Comparing zero-shot and few-shot outputs side by side

---

## Why this matters

Many product labels are not purely objective. "Billing" might take priority over "technical" when a failed webhook caused a double charge. Few-shot examples help teach those local business rules without training a custom model.

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
Input:
I was charged twice after the webhook failed.

Zero-shot: billing
Few-shot:  billing
------------------------------------------------------------
Input:
Do you offer onboarding calls for new teams?

Zero-shot: sales
Few-shot:  sales
```

---

## The code, explained

Zero-shot prompting sends only the rules and the current message:

```ts
content: `${rules}\n\nMessage: ${message}`
```

Few-shot prompting sends example pairs first:

```ts
{ role: "user", content: "The API failed and then I got charged..." },
{ role: "assistant", content: "billing" },
```

Those examples show the model how to apply the priority rule when labels overlap.

---

## The key insight

Zero-shot = instruction only. Few-shot = instruction plus examples. Few-shot is not fine-tuning; the examples cost tokens every time.

---

## What can go wrong

- Bad examples teach bad behavior.
- Too many examples increase cost and latency.
- Examples can conflict with written rules.
- Few-shot prompting improves consistency, but it does not guarantee correctness.

---

## Where this shows up in agents

Agents use few-shot examples for routing, classification, extraction, planner style, escalation decisions, and any step where the "right" behavior depends on product-specific examples.

---

## Try it yourself

- Add a message that mentions a refund and a crash.
- Add a confusing example and see how it affects later classifications.
- Remove the written rules and run with examples only.
