// ============================================================
//  第三章：agent-loop（智能体循环）
//
//  学习目标：
//  1. 区分“一问一答的工具调用”和“围绕目标持续行动的 agent”
//  2. 理解为什么 agent loop 必须有最大迭代次数
//  3. 学会用 terminal tool 让模型显式宣布任务完成
//  4. 观察模型如何自己决定先列文件、再读文件、最后写报告
//
//  核心结论：
//  Agent = 模型决策 + 工具执行 + 状态历史 + 停止条件。
//  没有停止条件的 agent，不是更智能，而是更容易失控。
// ============================================================

// Agent loop: the model pursues a goal over multiple steps, deciding what to do
// next each iteration. Unlike tool use (one query → one answer), the agent drives
// itself — you hand it a goal and it figures out how to reach it.

import "dotenv/config";
import OpenAI from "openai";
import client from "./src/openai-charles-client";

// const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

// The most important constant in any agent.
// Without this, a confused model runs until you hit your rate limit.
const MAX_ITERATIONS = 15;
// 最大迭代次数是 agent 的安全带。
// 每次模型调用工具或继续思考，都会消耗 token 和时间。

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
  // 工具 1：列出可审查文件。agent 不应该凭空知道有哪些文件。
  return JSON.stringify(Object.keys(FILES));
}

function readFile(path: string): string {
  // 工具 2：读取某个文件。只有读过文件，模型才能基于真实内容审查。
  const content = FILES[path];
  if (!content) return `未找到文件：${path}`;
  return content;
}

// Terminal tool — when the agent calls this, the task is done.
// This is more reliable than waiting for finish_reason === "stop":
// the agent explicitly signals completion rather than just stopping.
let finalReport: string | null = null;

function writeReport(content: string): string {
  // 工具 3：终止工具。模型调用它表示“我已经完成任务，要输出最终报告”。
  finalReport = content;
  return "报告已保存。";
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const tools: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "list_files",
      description: "列出所有可供审查的源代码文件",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "读取指定源代码文件的完整内容",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "文件路径，必须与 list_files 返回的路径完全一致，例如 src/auth.ts",
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
        "编写最终安全审计报告。审查完所有文件并汇总全部发现后调用此工具。" +
        "报告应按严重程度组织问题。调用此工具将结束审计。",
      parameters: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "使用 Markdown 格式编写的完整中文安全审计报告",
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
  // 所有工具请求都经过这里，便于集中做参数校验和权限控制。
  switch (name) {
    case "list_files":
      return listFiles();
    case "read_file":
      if (!args.path) return "缺少必填参数：path";
      return readFile(args.path);
    case "write_report":
      if (!args.content) return "缺少必填参数：content";
      return writeReport(args.content);
    default:
      // The model can hallucinate a tool name — always handle the unknown case.
      return `未知工具："${name}"`;
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
  // 和 02-tool-use 最大的区别：
  // 这里用户给的是一个目标，而不是一个具体问题。
  // 模型自己决定需要调用哪些工具、调用顺序是什么。
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content:
        "你是一名代码安全审计员。" +
        "首先列出所有文件，然后逐一仔细阅读。" +
        "只有审查完每个文件后，才能调用 write_report。" +
        "请使用中文撰写报告，并按严重程度组织发现：严重、高危、中危。",
    },
    { role: "user", content: goal },
  ];

  let iteration = 0;

  console.log(`目标：${goal}\n`);

  while (true) {
    iteration++;

    // Circuit breaker — remove this and a confused model runs until rate-limited.
    if (iteration > MAX_ITERATIONS) {
      throw new Error(
        `Agent exceeded ${MAX_ITERATIONS} iterations without completing the task. ` +
          `This usually means the model is stuck in a loop or the goal is too vague.`
      );
    }

    console.log(`[第 ${iteration} 次迭代]`);

    const response = await client.chat.completions.create({
      model: model,
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
          // write_report 已经把 finalReport 设置好，说明任务显式完成。
          // 这比“模型不再调用工具”更可靠。
          console.log(`  ← 报告已写入（${finalReport.length} 个字符）\n`);
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
    "审查此代码库中存在的安全漏洞。" +
      "请在撰写报告前审查每一个文件。"
  );

  console.log("─".repeat(60));
  console.log("\n最终报告：\n");
  console.log(report);
}

main().catch(console.error);
