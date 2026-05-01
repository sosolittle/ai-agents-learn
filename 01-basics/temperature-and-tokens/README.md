# Temperature and Tokens

Small generation settings can change whether output is predictable, creative, or cut off early.

---

## What this demonstrates

- Running the same prompt with `temperature: 0`
- Repeating the same low-temperature call and comparing outputs
- Increasing temperature for more variety
- Using a tiny `max_tokens` limit to force a cutoff
- Reading `finish_reason` to detect why generation stopped

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
Call 1: temperature=0, max_tokens=50
...
finish_reason: stop
------------------------------------------------------------
Call 2: temperature=0, max_tokens=50
...
Matched call 1: true
------------------------------------------------------------
Call 4: temperature=0, max_tokens=10
...
finish_reason: length
```

---

## The key insight

`temperature: 0` is not "smart mode." It is greedy mode: the model keeps picking the highest-probability next token.

`max_tokens` is a hard output budget. If it is too low, the model can stop mid-sentence with `finish_reason: "length"`. That is not an API error, so production apps need to check the stop reason and decide whether to retry, continue, or show a truncated answer.
