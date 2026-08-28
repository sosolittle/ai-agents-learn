# Web Search Agent

> Give the model a question. It searches until it's confident. Then it answers.

In the agent loop, all the tools were local — mock files, in-memory data. The model never left the process. In this pattern, the model reaches out to the real world. Every search call hits a live API and returns results that didn't exist when the code was written.

The loop structure is identical to `03-agent-loop`. The only thing that changed is what the tool does. That's the point.

---

## Where you already see this pattern

Every AI assistant that gives you sourced, up-to-date answers is running this pattern:

- **Perplexity** — your question triggers multiple searches, results are synthesized, sources are cited. The model never answers from memory alone
- **ChatGPT with web browsing** — when you ask about a recent event, the model searches before replying. You're seeing an agent loop where `web_search` is one of the tools
- **AI coding assistants checking package docs** — when you ask about a library function, some assistants search the latest docs rather than relying on training data that may be months old
- **Research assistants in enterprise tools** — given a brief, the agent searches multiple sources, reads results, and builds a synthesis. It queries once for the overview, again for a specific detail it noticed, again to verify a claim
- **Customer support bots with live knowledge bases** — the model searches a knowledge base tool instead of a web API, but the pattern is the same

What they all have in common: the model doesn't know the answer upfront. It searches, reads, decides whether it knows enough, and searches again if not. You never script that decision — the model makes it.

---

## The mental model

If you've written a `fetch` call in an Express handler, you already understand this.

The difference is who decides when to call it.

```
Normal fetch flow:    your code calls fetch() when it decides to
Web search agent:     model decides to call fetch() → you run it →
                      model reads results → model decides to call it again, or answers
```

You're writing the same fetch call. But now the **model is the one deciding** when to make it, what query to use, and how many times to try. That decision is what this pattern is about.

---

## How it works

Same loop structure as the agent loop — the only difference is what tools are available:

```
You:    [system prompt, research question]
              ↓
Iteration 1:
  Model:  → web_search("Node.js 22 features")       finish_reason: "tool_calls"
  You:    hit Tavily API, return 5 results as text
              ↓
Iteration 2:
  Model:  → web_search("Node.js 22 LTS schedule")   finish_reason: "tool_calls"
  You:    hit Tavily API again, return 5 more results
              ↓
Iteration 3:
  Model:  → write_answer("## Node.js 22...")         finish_reason: "tool_calls"
  You:    detect terminal tool, exit loop
              ↓
Done.
```

The model chose to search twice. Not because you told it to — because after the first search it decided it needed more specific information. That judgment call is the agent.

---

## Why Tavily

You could use any search API here. Brave, Google, Bing, SerpAPI — they all work.

Tavily is purpose-built for LLM agents. It returns clean, relevance-ranked text excerpts rather than raw HTML, which means:

- The model can read results directly — no HTML parsing step
- Excerpts are scoped to the relevant part of the page, not the whole document
- Results are scoped to the actual question, not generic page content

The difference in practice: with a raw HTML API, you'd need a second step to extract readable text from each result before feeding it to the model. With Tavily, that step is already done.

For this pattern, that means one fewer moving part and a cleaner demo. For production, the tradeoff is the same — Tavily is simpler to integrate but you're dependent on their relevance ranking.

---

## The two failure modes this pattern introduces

Adding real-world search adds two failure modes you won't see in the mock-data patterns.

### 1. The search spiral

The model decides it needs more information, searches, decides it still needs more, searches again, and never commits to an answer. This is the agent loop's infinite loop problem, but worse — each iteration costs an API call to an external service.

`MAX_ITERATIONS` is the circuit breaker. Without it, a model that's stuck in "one more search" mode runs until you hit rate limits.

```ts
const MAX_ITERATIONS = 10; // adjust based on the task, never remove it
```

The right value depends on the question. A simple factual query needs 1–2 searches. A multi-part research question might need 5–6. The point is the number is **intentional**, not infinite.

### 2. Hallucinated citations

The model will sometimes cite a URL that was never in its search results. It looks plausible — a real domain, a real-looking path — but the page doesn't exist or doesn't say what the model claims.

This happens because the model learned from billions of documents and knows what a citation looks like. When it constructs an answer, it pattern-matches on "answer that looks well-sourced" and fills in a URL from training data rather than search results.

The system prompt in this example explicitly addresses it:

```ts
"Only cite URLs that appeared in your actual search results — never invent sources."
```

This reduces hallucinated citations but doesn't eliminate them. In production, you validate every cited URL against the actual search results before surfacing it to users.

---

## The tool description problem

How you word the `web_search` description changes what queries the model generates.

```ts
// ❌ too permissive — model may ask vague questions and get poor results
description: "Search the web for information"

// ✅ gives the model a strategy — narrow queries return better results
description:
  "Search the web for current information. Use this whenever you need facts, " +
  "recent events, or data you don't know. You can call this multiple times with " +
  "different queries to build a complete picture before writing your answer."
```

The parameter description matters too:

```ts
// ❌ model generates "Node.js news" and gets noise
query: { type: "string", description: "Search query" }

// ✅ model generates "Node.js 22 LTS release date" and gets the answer
query: {
  type: "string",
  description:
    "A specific, focused search query. Narrow queries return better results " +
    "than broad ones — e.g. 'Node.js 22 release date' not 'Node.js news'."
}
```

Tool descriptions are the main lever you have on agent behavior. Treat them like prompts.

---

## What this example is / is not

**This example is:**
- a minimal runnable web search agent using real live search results
- a demonstration of the terminal tool pattern applied to research tasks
- a look at the two failure modes real-world search introduces (spiral + hallucination)

**This example is not:**
- a production research assistant
- an implementation with result validation, URL verification, or citation checking
- an agent with memory across sessions or the ability to read full web pages
- a replacement for a proper retrieval pipeline in real applications

The goal is to make the pattern clear. Real search agents add layers on top — this example keeps the concept visible.

---

## Run it

```bash
cp .env.example .env
# add your OPENAI_API_KEY and TAVILY_API_KEY to .env
# get a free Tavily key at https://tavily.com (1,000 searches/month free)

npm install
npm start
```

You'll see each iteration logged as the agent searches:

```
问题：Node.js 22 有哪些值得关注的新特性？它进入 LTS 了吗？

[第 1 次迭代]
  → 调用 web_search("Node.js 22 new features")
  ← [1] Node.js 22 Release: What's New? | URL: ...

[第 2 次迭代]
  → 调用 web_search("Node.js 22 LTS release date schedule")
  ← [1] Node.js Release Schedule | URL: ...

  → 调用 write_answer（1204 字符）
```

---

## Example output

A realistic transcript for the default question:

```
问题：Node.js 22 有哪些值得关注的新特性？它进入 LTS 了吗？

[第 1 次迭代]
  → 调用 web_search("Node.js 22 new features 2024")
  ← [1] Node.js 22 is now available! | URL: https://nodejs.org/en/blog/announcements/v22-release-announce…

[第 2 次迭代]
  → 调用 web_search("Node.js 22 LTS status release schedule")
  ← [1] Releases | Node.js | URL: https://nodejs.org/en/about/previous-releases…

  → 调用 write_answer（1521 字符）

────────────────────────────────────────────────────────────

答案：

## Node.js 22 — Notable Features and LTS Status

### Key new features

- **Native `fetch` stabilized** — the `fetch` API is now stable without a flag
- **`require()` for ESM** — experimental support for loading ES modules via `require()`
- **V8 12.4 engine** — includes WebAssembly improvements and new JS features
- **`--run` flag** — `node --run <script>` as a faster alternative to `npm run`
- **Watch mode improvements** — `--watch` is more stable and handles more file types

### LTS status

Node.js 22 entered **Active LTS in October 2024** and will receive long-term support
until April 2027. It is the current recommended version for production use.

Sources:
- https://nodejs.org/en/blog/announcements/v22-release-announce
- https://nodejs.org/en/about/previous-releases
```

The exact wording and depth will vary — the model composes the answer from whatever search results it retrieved at runtime.

---

## References

- [Tavily API docs](https://docs.tavily.com) — search parameters, result formats, and rate limits
- [Agent loop pattern](../03-agent-loop/index.ts) — the same loop structure without live external calls
- [Tool use pattern](../02-tool-use/index.ts) — the simpler version: one query, tools called once
- [OpenAI Function Calling guide](https://platform.openai.com/docs/guides/function-calling) — tool calling mechanics used throughout this series
