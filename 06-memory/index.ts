// Memory is a state management problem.
//
// The token context window is your RAM — finite and expensive. Every request
// pays for everything in the window. After enough turns, you hit the limit.
// These four strategies show the same tradeoff you face in any stateful system:
// what do you keep, what do you compress, and what do you evict?
//
// Run with:
//   npm start              → full-buffer (the naive default)
//   npm start window       → sliding-window (evicts old turns like LRU cache)
//   npm start summary      → summary (compresses old turns into a digest)
//   npm start persist      → persistent (saves facts across sessions to disk)

import "dotenv/config";
import OpenAI from "openai";
import * as fs from "fs";
import * as path from "path";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

type Message = OpenAI.Chat.ChatCompletionMessageParam;

// ---------------------------------------------------------------------------
// Memory interface
// ---------------------------------------------------------------------------

interface Memory {
  label: string;
  add(role: "user" | "assistant", content: string): Promise<void>;
  getMessages(): Message[];
}

// ---------------------------------------------------------------------------
// Strategy 1: Full buffer
//
// Keep every message. Zero extra complexity. Works perfectly in demos.
//
// The failure mode: context window grows linearly. Each API call pays for the
// entire conversation history. At 100 turns of a typical chat, you're pushing
// 10k–30k tokens into every request — before the model even starts responding.
// At some point you hit the model's context limit and the API throws an error.
// ---------------------------------------------------------------------------

class FullBufferMemory implements Memory {
  label = "full-buffer";
  private history: Message[] = [];

  async add(role: "user" | "assistant", content: string): Promise<void> {
    this.history.push({ role, content });
  }

  getMessages(): Message[] {
    return this.history;
  }
}

// ---------------------------------------------------------------------------
// Strategy 2: Sliding window
//
// Keep only the last N messages. Context window stays bounded. Cheap and simple.
//
// The silent bug: the model forgets anything before the window. If the user
// said their name at turn 1 and you're at turn 20, it's gone — permanently.
// Same as LRU cache eviction. You never see the error; the model just stops
// knowing things it once knew.
//
// Real-world shape: good for short, stateless exchanges (commands, one-shot
// questions). Bad for long conversations where early context matters.
// ---------------------------------------------------------------------------

class SlidingWindowMemory implements Memory {
  label = "sliding-window";
  private history: Message[] = [];

  constructor(private readonly windowSize: number = 6) {}

  async add(role: "user" | "assistant", content: string): Promise<void> {
    this.history.push({ role, content });
  }

  getMessages(): Message[] {
    // Keep an even number to preserve complete user/assistant pairs
    const keep = Math.floor(this.windowSize / 2) * 2;
    return this.history.slice(-keep);
  }
}

// ---------------------------------------------------------------------------
// Strategy 3: Summary memory
//
// When the history grows past a threshold, summarize the old turns into a
// single compressed "memory" message and discard them. Context stays bounded
// while meaning is preserved.
//
// The tradeoff: summaries lose resolution. You get "user prefers TypeScript"
// not the exact argument they made for it. For most conversational use cases,
// that's fine — you need the gist, not the transcript.
//
// Key design detail: we always compress after the assistant turn, never mid-turn.
// That way getMessages() is always in a clean, ready state when the next
// request is built.
// ---------------------------------------------------------------------------

class SummaryMemory implements Memory {
  label = "summary";
  private history: Message[] = [];
  private summary: string | null = null;

  constructor(private readonly summarizeAfter: number = 6) {}

  async add(role: "user" | "assistant", content: string): Promise<void> {
    this.history.push({ role, content });

    if (role === "assistant" && this.history.length > this.summarizeAfter) {
      await this.compress();
    }
  }

  private async compress(): Promise<void> {
    const toCompress = this.history.slice(0, -2); // keep the last exchange fresh
    this.history = this.history.slice(-2);

    const prior = this.summary
      ? `Prior summary:\n${this.summary}\n\n`
      : "";

    const turns = toCompress
      .map((m) => `${m.role}: ${m.content}`)
      .join("\n");

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content:
            `${prior}Summarize the key facts from this conversation in 3-5 bullet points. ` +
            `Focus on what the assistant would need to stay consistent in future turns: ` +
            `user goals, preferences, names, and any decisions made. ` +
            `Be specific. Skip filler and pleasantries.\n\n${turns}`,
        },
      ],
    });

    this.summary = response.choices[0].message.content ?? "";
    console.log(`  [summary] Compressed ${toCompress.length} messages → ${this.summary.length} chars`);
  }

  getMessages(): Message[] {
    const messages: Message[] = [];
    if (this.summary) {
      messages.push({
        role: "system",
        content: `Summary of earlier conversation:\n${this.summary}`,
      });
    }
    return [...messages, ...this.history];
  }
}

// ---------------------------------------------------------------------------
// Strategy 4: Persistent memory
//
// After each assistant reply, extract key facts and write them to disk.
// Inject them at session start. The agent remembers you next time — across
// restarts, across days.
//
// This is the same pattern as a user profile store in a web app: you don't
// replay the entire request history, you persist the signal and discard the noise.
//
// Run `npm start persist` twice with the same question to see it kick in.
// The second run will already know what the first run learned.
//
// memory.json is written to the current working directory and gitignored.
// ---------------------------------------------------------------------------

// memory.json is written to the directory where you run npm start.
const MEMORY_FILE = path.join(process.cwd(), "memory.json");

class PersistentMemory implements Memory {
  label = "persistent";
  private history: Message[] = [];
  private facts: string[] = [];

  constructor() {
    try {
      const raw = fs.readFileSync(MEMORY_FILE, "utf-8");
      this.facts = JSON.parse(raw) as string[];
    } catch {
      this.facts = [];
    }

    if (this.facts.length > 0) {
      console.log(`  [memory] Loaded ${this.facts.length} fact(s) from last session:`);
      this.facts.forEach((f) => console.log(`    - ${f}`));
    }
  }

  async add(role: "user" | "assistant", content: string): Promise<void> {
    this.history.push({ role, content });
    if (role === "assistant") {
      await this.extractAndSave();
    }
  }

  private async extractAndSave(): Promise<void> {
    const recentTurns = this.history
      .slice(-4)
      .map((m) => `${m.role}: ${m.content}`)
      .join("\n");

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content:
            `From this exchange, extract any facts worth remembering long-term ` +
            `(user name, preferences, stated goals, key decisions). ` +
            `Return JSON in exactly this format: {"facts": ["...", "..."]}. ` +
            `Return {"facts": []} if nothing is worth saving.\n\n${recentTurns}`,
        },
      ],
      response_format: { type: "json_object" },
    });

    try {
      const parsed = JSON.parse(
        response.choices[0].message.content ?? "{}"
      ) as { facts?: string[] };

      const newFacts = (parsed.facts ?? [])
        .map((f: string) => f.trim())
        .filter((f: string) => f.length > 0);

      if (newFacts.length > 0) {
        // Deduplicate and keep a rolling cap so the file never grows unbounded
        this.facts = Array.from(new Set([...this.facts, ...newFacts])).slice(-20);
        fs.writeFileSync(MEMORY_FILE, JSON.stringify(this.facts, null, 2));
        console.log(`  [memory] Saved ${newFacts.length} new fact(s)`);
      }
    } catch {
      // Non-fatal — skip saving for this turn rather than crashing
    }
  }

  getMessages(): Message[] {
    const messages: Message[] = [];
    if (this.facts.length > 0) {
      messages.push({
        role: "system",
        content: `What I remember about you from past conversations:\n${this.facts.map((f) => `- ${f}`).join("\n")}`,
      });
    }
    return [...messages, ...this.history];
  }
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

async function chat(memory: Memory, userMessage: string): Promise<string> {
  await memory.add("user", userMessage);

  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content:
          "You are a helpful assistant. Keep replies to 2-3 sentences. " +
          "If asked about something from earlier in the conversation, " +
          "answer based only on what you can actually see in the conversation history.",
      },
      ...memory.getMessages(),
    ],
  });

  const reply = response.choices[0].message.content ?? "";
  await memory.add("assistant", reply);
  return reply;
}

// ---------------------------------------------------------------------------
// Demo
//
// 10 turns on a single topic. Turn 1 plants a key fact (name + project).
// Turn 10 asks for it directly. Each strategy handles that question differently:
//
//   full-buffer   → answers correctly (nothing is ever evicted)
//   sliding-window→ fails (turn 1 is outside the 6-message window)
//   summary       → answers correctly (the fact survived compression)
//   persistent    → answers correctly (the fact was saved to disk)
//
// The turn 10 failure of sliding-window is the insight. In demos, agents look
// great. In production, that turn-1 context is gone by turn 20.
// ---------------------------------------------------------------------------

const CONVERSATION: string[] = [
  "Hi! My name is Alex. I'm building a real-time dashboard in React with WebSockets.",
  "What are some good libraries for WebSocket state management in React?",
  "Tell me about the tradeoffs between SWR and React Query for this use case.",
  "Which one handles server-sent events better?",
  "What's the actual difference between SSE and WebSockets at the protocol level?",
  "When would polling be a better choice than WebSockets?",
  "And long polling — how is that different from regular polling?",
  "How does any of this relate to the CAP theorem?",
  "How do distributed systems handle network partitions in practice?",
  "One last thing — what was my name, and what project was I building?",
];

async function runDemo(memory: Memory): Promise<void> {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`Strategy: ${memory.label.toUpperCase()}`);
  console.log("═".repeat(60));

  for (let i = 0; i < CONVERSATION.length; i++) {
    const userMsg = CONVERSATION[i];
    const reply = await chat(memory, userMsg);

    console.log(`\n[turn ${i + 1}]`);
    console.log(`User:      ${userMsg}`);
    console.log(`Assistant: ${reply}`);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const strategy = process.argv[2] ?? "full";

  const memory: Memory =
    strategy === "window"
      ? new SlidingWindowMemory(6)
      : strategy === "summary"
      ? new SummaryMemory(6)
      : strategy === "persist"
      ? new PersistentMemory()
      : new FullBufferMemory();

  await runDemo(memory);
}

main().catch(console.error);
