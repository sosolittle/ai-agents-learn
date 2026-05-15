# Agent Memory

> Memory in LLM agents is a state management problem. The context window is your RAM — finite, expensive, and read in full on every request.

In the previous patterns, every conversation started fresh. The model had no memory of prior turns beyond what the current request contained. That's fine for one-shot tasks. For multi-turn conversations, it's a silent bug waiting to surface in production.

This pattern shows four strategies for managing conversation history: what they keep, what they lose, and when each one breaks.

---

## The problem with `messages.push()`

The naive approach is to append every turn to an array and pass the whole thing to the API:

```ts
messages.push({ role: "user", content: userMessage });
messages.push({ role: "assistant", content: reply });
// next request: send all of messages
```

This works. In a 10-turn demo, it works perfectly. In a 100-turn production conversation, every request now includes the full history — and you're paying for every token of it, on every request, in addition to the new message you actually care about. Eventually you hit the model's context limit and the API returns an error.

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

| Strategy        | Answers turn-10 correctly? | Why |
|----------------|---------------------------|-----|
| full-buffer     | ✅ Yes                    | Turn 1 is still in the window |
| sliding-window  | ❌ No                     | Turn 1 was evicted — window only holds turns 5–10 |
| summary         | ✅ Yes                    | The fact survived compression |
| persistent      | ✅ Yes                    | The fact was saved to disk |

The sliding-window failure is the insight. Agents look great in demos. In production, that turn-1 context is gone by turn 20, and no error is thrown — the model just silently doesn't know anymore.

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

## Run it

```bash
cp .env.example .env
# add your OPENAI_API_KEY

npm install
npm start              # full-buffer — everything in context
npm start window       # sliding-window — forgets turn 1 by turn 10
npm start summary      # summary — compresses old turns
npm start persist      # persistent — run it twice to see cross-session memory
```

To see the sliding-window failure clearly, run `npm start window` and watch turn 10. The model won't know the name or project — not because it's broken, but because that information was evicted 4 turns ago.

To see persistent memory across sessions: run `npm start persist`, then run it again. The second run starts with facts extracted from the first.

---

## What the output looks like

```
════════════════════════════════════════════════════════════
Strategy: SLIDING-WINDOW
════════════════════════════════════════════════════════════

[turn 1]
User:      Hi! My name is Alex. I'm building a real-time dashboard in React with WebSockets.
Assistant: Nice to meet you, Alex! That sounds like a great project...

[turn 2]
User:      What are some good libraries for WebSocket state management in React?
...

[turn 10]
User:      One last thing — what was my name, and what project was I building?
Assistant: I'm sorry, I don't have access to information about your name or project
           from earlier in our conversation.
```

That last response is the bug. Not an exception. Not an error log. The model just... doesn't know.

---

## What this example is / is not

**This example is:**
- a clear demonstration of four memory strategies with the same interface
- a reveal of the sliding-window failure mode that hits real production agents
- a foundation for understanding where frameworks like LangChain's `ConversationBufferWindowMemory` come from

**This example is not:**
- a production memory system with deduplication, vector search, or semantic retrieval
- an implementation with embeddings-based similarity for fact lookup
- a replacement for a proper long-term memory layer in a production agent

The goal is to make the tradeoffs visible. Real memory systems combine these strategies — persistent storage for facts, summaries for conversation context, and vector search for semantic recall. This example keeps each strategy isolated so the mechanics are clear.

---

## References

- [Agent loop pattern](../03-agent-loop/index.ts) — the loop structure that memory plugs into
- [OpenAI Chat Completions API](https://platform.openai.com/docs/api-reference/chat) — how messages are structured and priced per token
