// Agent loop: the model pursues a goal over multiple steps, deciding what to do
// next each iteration. Unlike tool use (one query → one answer), the agent drives
// itself — you hand it a goal and it figures out how to reach it.

import "dotenv/config";
import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// The most important constant in any agent.
// Without this, a confused model runs until you hit your rate limit.
const MAX_ITERATIONS = 15;

// ---------------------------------------------------------------------------
// Mock codebase — four files, three with planted security issues.
// In a real agent these would be actual file system reads.
// The agent doesn't know what's in them until it reads each one.
// ---------------------------------------------------------------------------

const FILES: Record<string, string> = {
  "src/auth.ts": `
import jwt from "jsonwebtoken";

export function createToken(userId: string) {
  // TODO: move secret to env var
  return jwt.sign({ userId }, "hardcoded-secret-123", { expiresIn: "7d" });
}

export function verifyToken(token: string) {
  return jwt.verify(token, "hardcoded-secret-123");
}
  `.trim(),

  "src/db.ts": `
import mysql from "mysql2";

export function getConnection() {
  return mysql.createConnection({
    host: "localhost",
    user: "root",
    password: "admin123",
    database: "app_db",
  });
}

export function queryUser(id: string) {
  const conn = getConnection();
  // user input concatenated directly into the query
  return conn.query("SELECT * FROM users WHERE id = " + id);
}
  `.trim(),

  "src/api.ts": `
import express from "express";
import { queryUser } from "./db";

const app = express();
app.use(express.json());

app.get("/user/:id", async (req, res) => {
  const user = await queryUser(req.params.id);
  res.json(user);
});

app.post("/upload", (req, res) => {
  const { filename } = req.body;
  // no validation on filename — path traversal risk
  const filePath = "/uploads/" + filename;
  res.json({ path: filePath });
});

export default app;
  `.trim(),

  "src/utils.ts": `
export function formatDate(date: Date): string {
  return date.toISOString().split("T")[0];
}

export function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

export function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max) + "..." : str;
}
  `.trim(),
};

// ---------------------------------------------------------------------------
// Tools — list files, read a file, and one terminal tool to end the run.
// The agent decides the order. You don't script the steps.
// ---------------------------------------------------------------------------

function listFiles(): string {
  return JSON.stringify(Object.keys(FILES));
}

function readFile(path: string): string {
  const content = FILES[path];
  if (!content) return `File not found: ${path}`;
  return content;
}

// Terminal tool — when the agent calls this, the task is done.
// This is more reliable than waiting for finish_reason === "stop":
// the agent explicitly signals completion rather than just stopping.
let finalReport: string | null = null;

function writeReport(content: string): string {
  finalReport = content;
  return "Report saved.";
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const tools: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List all source files available for review",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the full contents of a source file",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "File path exactly as returned by list_files — e.g. src/auth.ts",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_report",
      description:
        "Write the final security audit report. Call this once you have reviewed " +
        "every file and compiled all findings. Include issues organized by severity. " +
        "Calling this ends the audit.",
      parameters: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "The complete security audit report in markdown format",
          },
        },
        required: ["content"],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// parseToolArgs — arguments arrive as a JSON string, never a plain object.
// ---------------------------------------------------------------------------

function parseToolArgs(raw: string): Record<string, string> {
  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

function executeTool(name: string, args: Record<string, string>): string {
  switch (name) {
    case "list_files":
      return listFiles();
    case "read_file":
      if (!args.path) return "Missing required argument: path";
      return readFile(args.path);
    case "write_report":
      if (!args.content) return "Missing required argument: content";
      return writeReport(args.content);
    default:
      // The model can hallucinate a tool name — always handle the unknown case.
      return `Unknown tool: "${name}"`;
  }
}

// ---------------------------------------------------------------------------
// The agent loop — the core of this pattern.
//
// The key difference from tool use: WHO drives the loop.
//   Tool use:   you ask a question → model calls tools → model answers
//   Agent loop: you give a goal → model decides what to do → repeats until done
//
// The model plans its own steps. It reads files in whatever order makes sense,
// decides when it has enough information, and calls write_report when done.
// You never tell it the sequence. That's the point.
//
// Two failure modes this defends against:
//   1. Infinite loop — model gets confused and keeps calling tools forever
//   2. Runaway context — each iteration appends messages; long runs overflow
//
// Iteration flow for this demo (approximate):
//   iteration 1:  → list_files()                  ← discovers 4 files
//   iteration 2:  → read_file("src/auth.ts")       ← finds hardcoded secret
//   iteration 3:  → read_file("src/db.ts")         ← finds SQL injection + creds
//   iteration 4:  → read_file("src/api.ts")        ← finds path traversal
//   iteration 5:  → read_file("src/utils.ts")      ← clean file, no issues
//   iteration 6:  → write_report("# Security...")  ← task complete, loop exits
// ---------------------------------------------------------------------------

async function runAgent(goal: string): Promise<string> {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content:
        "You are a security code auditor. " +
        "Start by listing all files, then read each one carefully. " +
        "Only call write_report after you have reviewed every file. " +
        "Organize findings by severity: Critical, High, Medium.",
    },
    { role: "user", content: goal },
  ];

  let iteration = 0;

  console.log(`Goal: ${goal}\n`);

  while (true) {
    iteration++;

    // Circuit breaker — remove this and a confused model runs until rate-limited.
    if (iteration > MAX_ITERATIONS) {
      throw new Error(
        `Agent exceeded ${MAX_ITERATIONS} iterations without completing the task. ` +
          `This usually means the model is stuck in a loop or the goal is too vague.`
      );
    }

    console.log(`[iteration ${iteration}]`);

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      tools,
      tool_choice: "auto",
    });

    const choice = response.choices[0];
    messages.push(choice.message); // always append — model needs its own history

    // Exit condition A: model stopped calling tools and replied directly.
    // Shouldn't happen in this demo (write_report always fires first), but handle it.
    if (choice.finish_reason === "stop") {
      console.log();
      return choice.message.content ?? "";
    }

    if (choice.finish_reason === "tool_calls") {
      const toolCalls = choice.message.tool_calls ?? [];

      for (const call of toolCalls) {
        const args = parseToolArgs(call.function.arguments);
        const displayArgs = JSON.stringify(args);
        console.log(`  → ${call.function.name}(${displayArgs === "{}" ? "" : displayArgs})`);

        const result = executeTool(call.function.name, args);

        // Exit condition B: terminal tool called — agent is done.
        if (call.function.name === "write_report" && finalReport !== null) {
          console.log(`  ← report written (${finalReport.length} chars)\n`);
          // Push the result so message history stays valid, then exit cleanly.
          messages.push({ role: "tool", tool_call_id: call.id, content: result });
          return finalReport;
        }

        // Truncate long results in the log — full content still goes into messages.
        const preview = result.length > 80 ? result.slice(0, 80) + "…" : result;
        console.log(`  ← ${preview}`);

        messages.push({ role: "tool", tool_call_id: call.id, content: result });
      }

      console.log();
    }
  }
}

// ---------------------------------------------------------------------------
// Demo
// ---------------------------------------------------------------------------

async function main() {
  const report = await runAgent(
    "Audit this codebase for security vulnerabilities. " +
      "Review every file before writing your report."
  );

  console.log("─".repeat(60));
  console.log("\nFinal report:\n");
  console.log(report);
}

main().catch(console.error);
