# AI Agents From Scratch

> Learn how AI agents actually work by building every core pattern from zero — no frameworks, just code and concepts.

This is a structured learning lab, not a library. Each folder is one self-contained pattern you can read, run, and copy in under five minutes.

---

## Why this exists

Most agent tutorials either hide the complexity inside a framework, or throw you into production-grade code before you understand the fundamentals. This repo sits in the middle: real working code, minimal dependencies, maximum clarity.

AI Agents From Scratch is a learning lab where I document the core engineering patterns behind AI agents by building each concept from zero in TypeScript. No frameworks, no magic abstractions — just small, runnable examples that show how the pattern actually works.

Later, these same patterns can be combined into larger systems such as workflow builders, support assistants, research agents, or internal automation tools.

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
| [system-vs-user-prompt](./01-basics/system-vs-user-prompt/) | Comparing system instructions with user prompts |
| [temperature-and-tokens](./01-basics/temperature-and-tokens/) | Seeing how temperature and token limits affect output |
| [prompt-templates](./01-basics/prompt-templates/) | Filling simple string templates with variables |
| [few-shot-prompting](./01-basics/few-shot-prompting/) | Providing examples in context instead of fine-tuning |
| [error-handling-retries](./01-basics/error-handling-retries/) | Retrying rate limits and transient failures safely |
| [input-output-validation](./01-basics/input-output-validation/) | Validating prompts and model output at the boundary |

### 02 — Tool Use

| Pattern | What it demonstrates |
|---|---|
| [tool-use](./02-tool-use/) | Function calling: LLM decides which of your functions to call, with what args, in a multi-round loop |

### 03 — Agent Loop

| Pattern | What it demonstrates |
|---|---|
| [agent-loop](./03-agent-loop/) | Goal-directed agent that decides its own next steps each iteration, with a MAX_ITERATIONS circuit breaker and terminal tool pattern |

### 04 — Web Search

| Pattern | What it demonstrates |
|---|---|
| [web-search](./04-web-search/) | Agent loop with a live web search tool: the model searches, reads results, decides whether to search again, and writes a sourced answer |

*More patterns coming — memory, multi-agent, reliability, observability.*

---

## License

MIT
