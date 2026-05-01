# Few-Shot Prompting

Few-shot prompting gives the model examples in the context window before asking it to solve the real input.

---

## What this demonstrates

- Classifying support messages with zero-shot prompting
- Classifying the same messages with three examples first
- Using user and assistant messages as example pairs
- Comparing the outputs side by side

---

## Run it

```bash
cp .env.example .env
# add your OPENAI_API_KEY to .env

npm install
npm start
```

Expected output:

```text
Input:
I was charged twice for my monthly plan.

Zero-shot: billing
Few-shot:  billing
------------------------------------------------------------
Input:
The dashboard crashes whenever I upload a CSV.
```

---

## The key insight

Few-shot is not fine-tuning. You are not changing the model's weights or teaching it permanently.

You are giving the model a pattern to match inside the current context window. Those examples are sent with every request and cost tokens every time. More examples can mean more consistent output, but it also means higher latency and higher cost.
