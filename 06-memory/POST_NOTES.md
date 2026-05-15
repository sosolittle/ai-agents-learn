# LinkedIn Post Notes — Agent Memory

---

## Core angle

Most developers think agent memory means saving chat history. That works in demos, then fails in production. Memory is really a state-management problem: what do you keep, compress, evict, and persist?

The context window is not memory. It is RAM. And like RAM, it is finite, expensive, and wiped on every restart.

---

## Hook options

1. "Most AI agents don't forget because the model is bad. They forget because your memory strategy is bad."
2. "The context window is not memory. It is RAM."
3. "messages.push() is fine for demos. It is dangerous for long-running agents."
4. "Agent memory is just state management with expensive RAM."
5. "Sliding-window memory does not fail loudly. It fails silently."

---

## Main teaching points

- Full buffer works until cost and context explode — it's the default everyone ships to production without realizing.
- Sliding window controls cost but silently forgets. No exception, no warning. The model just stops knowing things it once knew.
- Summary memory compresses meaning but loses detail. You get "user prefers TypeScript," not the exact argument they made.
- Persistent memory survives sessions but creates privacy and product responsibilities — user consent, deletion controls, trust boundaries.
- Real agents almost always need a hybrid: sliding window or summary for active context, persistent storage for long-term facts, and retrieval for semantic recall.
- This is the same set of tradeoffs as React state management. Full buffer = useState([]). Sliding window = LRU cache. Summary = useMemo. Persistent = localStorage. MERN devs will recognize these bugs immediately.

---

## Code snippet to feature

The Memory interface is the cleanest thing to show — four strategies, one contract:

```ts
interface Memory {
  add(role: "user" | "assistant", content: string): Promise<void>;
  getMessages(): Message[];
}
```

Then show the chat() function calling memory.getMessages() without knowing which strategy it has — that's the point. Swap the strategy, get different behavior. The conversation logic doesn't change.

Alternatively, the sliding-window failure moment is the most shareable demo output — the model saying "I don't have access to information about your name" after you introduced yourself at turn 1.

---

## Visual idea

A simple horizontal diagram:

- Left: "Turn 1: Alex says his name"
- Middle: arrows showing what each strategy keeps vs. evicts by turn 10
- Right: turn-10 response — correct for full/summary/persistent, blank for sliding window

Or: two columns showing context window as RAM vs. memory.json as disk, with summary as the compression layer in between.

---

## CTA options

- "I'm building AI agent patterns from scratch in TypeScript — next topic: retrieval. Full repo in the comments."
- "Full code is in the repo: AI Agents From Scratch. Link in the comments — no frameworks, just the mechanics."
- "Next, I'll show how memory connects with retrieval — when you need to find relevant facts by meaning, not recency."
