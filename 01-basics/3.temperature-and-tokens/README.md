# Temperature and Tokens

Temperature and token limits control how a model generates text: how much variety it explores and how much room it has to answer.

---

## What this demonstrates

- Running a naming prompt with `temperature: 0` twice
- Comparing medium and high temperature outputs
- Using `max_tokens` to limit response length
- Printing `finish_reason` and token usage when available

---

## Why this matters

Agent systems use different model settings for different jobs. A routing or validation step needs stability. A brainstorming step needs variety. Token limits also affect cost, latency, and whether the user sees a complete answer.

Use lower temperature for:

- Classification
- Extraction
- SQL generation
- Tool routing
- Validation

Use higher temperature for:

- Brainstorming
- Naming
- Copywriting
- Creative drafts

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
Prompt:
Generate 5 product names for a visual AI workflow builder for developers.
------------------------------------------------------------
Call 1
settings: temperature=0, max_tokens=120

output:
1. FlowForge AI
2. AgentCanvas
...

finish_reason: stop
tokens: prompt=18, completion=58, total=76
------------------------------------------------------------
Call 5
settings: temperature=0.7, max_tokens=20

finish_reason: length
```

---

## The code, explained

The helper keeps the prompt constant and changes only the generation settings:

```ts
temperature,
max_tokens: maxTokens,
messages: [{ role: "user", content: prompt }],
```

It also reads the response metadata:

```ts
choice.finish_reason
response.usage
```

`finish_reason` tells you whether the model stopped naturally or hit a limit. Token usage helps you see the cost shape of the call.

---

## The key insight

Temperature controls randomness and variety, not intelligence. `max_tokens` controls output budget, not quality.

---

## What can go wrong

- High temperature can create inconsistent output.
- Temperature 0 is more stable, but it is not "smart mode."
- Low `max_tokens` can cut off valid responses.
- Ignoring `finish_reason` can show incomplete answers to users.

---

## Where this shows up in agents

Agents often mix strict steps and creative steps. A planner might use moderate temperature, a tool router might use low temperature, and a naming or writing step might use higher temperature.

---

## Try it yourself

- Change the prompt from product names to API endpoint names.
- Run `temperature: 1.5` and compare how usable the names feel.
- Increase the final call from `max_tokens: 20` to `max_tokens: 80` and watch `finish_reason`.
