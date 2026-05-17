# Agent Memory

Most agent demos look impressive until you hit turn 20. By then, the model has quietly forgotten the user's name, their stated goal, and every decision made in the first ten minutes. No error is thrown. The model just stops knowing things it once knew.

Memory in LLM agents is a state management problem. The context window is your RAM — finite, expensive, and read in full on every request. How you decide what to keep, compress, evict, and persist determines whether your agent stays coherent across a long conversation or silently degrades.

This chapter shows four memory strategies from scratch in TypeScript, without LangChain or agent frameworks, so you can see the tradeoffs directly.

---

## The mental model

```
Context window  =  RAM
Full buffer     =  keep everything in RAM until it overflows
Sliding window  =  cache eviction — oldest entry goes first
Summary memory  =  compression — shrink old data, preserve signal
Persistent      =  database/profile store — survives restarts
```

| Strategy | What it keeps | What it loses | Best for |
|---|---|---|---|
| Full buffer | Every message, always | Nothing — until the context limit throws an error | Short, bounded conversations |
| Sliding window | The last N messages | Anything before the window — permanently, silently | Stateless commands, quick Q&A |
| Summary memory | A compressed digest of old turns + recent messages | Exact wording and fine detail | Long conversations where early context matters |
| Persistent memory | Extracted facts written to disk, reloaded next session | Conversation flow and context not yet extracted | Cross-session recall, user preferences |

---

## The problem with `messages.push()`

The naive approach is to append every turn to an array and pass the whole thing to the API:

```ts
messages.push({ role: "user", content: userMessage });
messages.push({ role: "assistant", content: reply });
// next request: send all of messages
```

This works. In a 10-turn demo, it works perfectly. In a 100-turn production conversation, every request includes the full history — and you're paying for every token of it, on every request, in addition to the new message you actually care about. Eventually you hit the model's context limit and the API returns an error.

The fix isn't "use a library." It's understanding the tradeoff: what do you keep, what do you evict, and what do you preserve across sessions?

---

## The four strategies

### 1. Full buffer

Keep every message. Zero complexity. The default everyone starts with.

**Failure mode:** linear cost growth. Turn 1 is always in the window. By turn 100 you're sending tens of thousands of tokens on every request — before the model replies. At some point the context limit throws an error.

**When it's fine:** short, bounded conversations. If you know the conversation ends in 10–20 turns, don't add complexity.

### 2. Sliding window

Keep only the last N messages. Bounded cost. Simple to reason about.

**Failure mode:** eviction is silent and absolute. The model stops knowing things it once knew — with no indication that information was lost. If the user said their name at turn 1 and you're at turn 20 with a window of 6, that fact is gone. Permanently.

This is exactly the LRU cache bug: great for throughput, wrong when old context matters.

**When it's fine:** stateless exchanges — commands, queries, quick Q&A where each turn stands alone.

### 3. Summary memory

When history grows past a threshold, summarize old turns into a compact digest and discard them. Keeps cost bounded while preserving meaning.

**The tradeoff:** summaries lose resolution. You get the signal, not the wording. "User is building a React WebSocket dashboard" survives. The specific library the user mentioned three turns ago may not.

**Key implementation detail:** always compress after the assistant turn, never mid-turn. The next `getMessages()` call needs a clean, summarized state — not a history mid-compression.

**When it's right:** long conversations where early context matters but verbatim recall doesn't.

### 4. Persistent memory

Extract key facts after each assistant reply and save them to disk. Inject them at session start. The agent knows things from last time.

This is the same pattern as a user profile store in any web app: don't replay the entire request history, persist the signal and discard the noise.

**When it's right:** sessions that span restarts. Onboarding flows where user preferences should carry forward. Any agent that should improve with each interaction.

---

## When to use which strategy

| Use case | Recommended strategy |
|---|---|
| 5-turn support chat | Full buffer |
| Stateless command assistant | Sliding window |
| Long coaching or tutoring conversation | Summary memory |
| User preferences across sessions | Persistent memory |
| Production personal assistant | Hybrid: summary + persistent + retrieval |

---

## How it works

All four strategies share the same interface:

```ts
interface Memory {
  add(role: "user" | "assistant", content: string): Promise<void>;
  getMessages(): Message[];
}
```

The `chat()` function doesn't know which strategy it's using:

```ts
async function chat(memory: Memory, userMessage: string): Promise<string> {
  await memory.add("user", userMessage);

  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [systemPrompt, ...memory.getMessages()],
  });

  const reply = response.choices[0].message.content ?? "";
  await memory.add("assistant", reply);
  return reply;
}
```

Swap the strategy, get different behavior. The conversation logic doesn't change — only what the memory object decides to keep.

---

## What the demo reveals

The demo runs 10 turns on one topic. Turn 1 plants a key fact:

```
"Hi! My name is Alex. I'm building a real-time dashboard in React with WebSockets."
```

Turn 10 asks for it:

```
"One last thing — what was my name, and what project was I building?"
```

Each strategy answers differently:

| Strategy | Answers turn-10 correctly? | Why |
|---|---|---|
| full-buffer | Yes | Turn 1 is still in the window |
| sliding-window | No | Turn 1 was evicted — window only holds turns 5–10 |
| summary | Yes | The fact survived compression |
| persistent | Yes | The fact was saved to disk |

The sliding-window failure is the insight. Agents look great in demos. In production, that turn-1 context is gone by turn 20, and no error is thrown — the model just silently doesn't know anymore.

---

## What the output looks like

**Sliding window — the silent failure:**

```
[turn 1]
User:      Hi! My name is Alex. I'm building a real-time dashboard in React with WebSockets.
Assistant: Nice to meet you, Alex! That sounds like a great project...

[turn 10]
User:      One last thing — what was my name, and what project was I building?
Assistant: I'm sorry, I don't have access to information about your name or
           project from earlier in our conversation.
```

That last response is not an exception. Not an error log. The model just doesn't know.

**Summary memory — the fact survives:**

```
[summary] Compressed 8 messages → 312 chars

[turn 10]
User:      One last thing — what was my name, and what project was I building?
Assistant: Your name is Alex, and you're building a real-time dashboard in
           React using WebSockets.
```

The summary preserved what mattered and discarded the filler.

**Persistent memory — second run loads what the first run learned:**

```
[memory] Loaded 2 fact(s) from last session:
  - The user's name is Alex.
  - Alex is building a real-time dashboard in React with WebSockets.

[turn 1]
User:      Hi! My name is Alex...
Assistant: Welcome back, Alex! Last time you were working on a real-time
           React dashboard with WebSockets. Want to pick up where we left off?
```

---

## The React / state management analogy

If you've worked with React state, you already understand the tradeoffs:

```
useState([])        ↔  full-buffer    — keep everything, never evict
useState(last6)     ↔  sliding-window — fixed-size buffer, oldest goes first
useMemo(summary)    ↔  summary        — derived compressed state from raw data
localStorage        ↔  persistent     — survives component unmounts and reloads
```

The bugs map too. Stale closure in React = stale fact in a sliding window. Missed state update = missed summarization. Corrupted localStorage = malformed memory.json. Same class of problem, different runtime.

---

## Privacy and trust boundaries

Persistent memory writes extracted facts to `memory.json`. This is fine for a local demo. Real products require more thought:

- **User consent:** users should know what facts are being saved and why.
- **Deletion controls:** users should be able to inspect and delete stored memory.
- **Trust boundaries:** saved facts should not be treated as trusted system instructions. Memory can be wrong, stale, duplicated, or over-personalized. Injecting it into the system prompt without validation is a prompt-injection risk.
- **Scope:** what the model extracts from a conversation is not always what the user intended to share permanently.

Persistent memory is a product responsibility, not just a technical one.

---

## What production systems add

This example keeps each strategy isolated so the mechanics are clear. Production memory systems layer several of these together and add:

- user-specific storage (not a shared file)
- memory deletion and edit controls
- deduplication and conflict resolution across sessions
- vector retrieval for semantic recall (find relevant facts by meaning, not recency)
- memory scoring and importance ranking
- expiry / TTL for stale facts
- audit logs of what was saved and when
- privacy controls and user-facing visibility
- prompt-injection protection around stored memory

None of that is in scope here. The goal is to make the tradeoffs visible before adding production complexity.

---

## Run it

```bash
cp .env.example .env
# add your OPENAI_API_KEY

npm install
npm start              # full-buffer — everything in context
npm start window       # sliding-window — forgets turn 1 by turn 10
npm start summary      # summary — compresses old turns
npm start persist      # persistent — run twice to see cross-session memory
```

To see the sliding-window failure clearly, run `npm start window` and watch turn 10. The model won't know the name or project — not because it's broken, but because that information was evicted 4 turns ago.

To see persistent memory across sessions: run `npm start persist`, then run it again. The second run starts with facts extracted from the first.

---

## What you should understand after this

- Why naive message history breaks at scale
- Why memory is a tradeoff, not a feature
- Why sliding windows fail silently — no exception, no warning
- How summarization compresses conversation state while preserving meaning
- How persistent memory differs from conversation history
- Why production memory needs privacy controls and trust boundaries

---

## References

- [Agent loop pattern](../03-agent-loop/index.ts) — the loop structure that memory plugs into
- [OpenAI Chat Completions API](https://platform.openai.com/docs/api-reference/chat) — how messages are structured and priced per token
