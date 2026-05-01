# AI Agents From Scratch

> Learn how AI agents actually work by building every core pattern from zero — no frameworks, just code and concepts.

This is a structured learning lab, not a library. Each folder is one self-contained pattern you can read, run, and copy in under five minutes.

---

## Why this exists

Most agent tutorials either hide the complexity inside a framework, or throw you into production-grade code before you understand the fundamentals. This repo sits in the middle: real working code, minimal dependencies, maximum clarity.

Every pattern here maps directly to something I built in [AgentFlow](https://github.com/zeeshanahmad/agentflow) — a visual AI agent workflow builder. The goal is to show the concepts naked first, then show what they look like inside a real product.

---

## How to use this

**Read first, run second.** Open the README for a folder, understand the concept, then run the code.

Each example is standalone:

```bash
cd 01-basics/simple-llm-call
cp .env.example .env        # add your API key
npm install
npx ts-node index.ts
```

You need:
- Node.js 18+
- an OpenAI API key (get one at [platform.openai.com](https://platform.openai.com))

---

## The series

This repo is the backbone of my **"AI Agents From Scratch"** LinkedIn series. Each folder = one post.

---

## Patterns

### 01 — Basics

| Pattern | What it demonstrates |
|---|---|
| [simple-llm-call](./01-basics/simple-llm-call/) | One API call, reading the response, understanding tokens |
| [prompt-chaining](./01-basics/prompt-chaining/) | Passing output of one call as input to the next |
| [structured-output](./01-basics/structured-output/) | Getting reliable JSON back from an LLM |
| [streaming](./01-basics/streaming/) | Handling partial response chunks as they arrive |
| [conversation-history](./01-basics/conversation-history/) | Maintaining multi-turn memory with a messages array |

*More patterns coming — agent loops, tool use, memory, multi-agent, reliability, observability.*

---

## License

MIT
