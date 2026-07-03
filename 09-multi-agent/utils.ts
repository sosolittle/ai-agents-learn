// ============================================================
//  第九章 utils：多 Agent 共用工具
//
//  学习目标：
//  1. 学会在模型输出边界做 JSON parse + Zod schema 校验
//  2. 用清晰错误信息定位是哪个 agent 的输出坏了
//  3. 把终端打印和文本预览这类小工具集中复用
// ============================================================

// Small helpers shared across the agents.
//
// The JSON parsing here validates each agent's output against a Zod schema so
// that a malformed handoff fails loudly at the boundary. Parse the JSON, then
// confirm its shape matches the contract; otherwise throw a clear error.

import { z } from "zod";

/**
 * Parse a model response that is expected to match a Zod schema.
 * Throws a clear, labelled error if the text is not valid JSON or does not
 * match the schema, so a bad handoff between agents is easy to spot.
 */
export function safeJsonParse<T>(
  raw: string,
  agentName: string,
  schema: z.ZodType<T>
): T {
  // 这个函数是 agent handoff 的“验收口”。
  // 上一个 agent 生成的文本，必须通过这里才能交给下一个 agent。
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `${agentName} did not return valid JSON. Got:\n${preview(raw, 200)}`
    );
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `${agentName} returned invalid shape.\n${result.error.toString()}\nRaw:\n${preview(raw, 200)}`
    );
  }

  return result.data;
}

/** Print a labelled section header so each stage is easy to read in the console. */
export function printSection(title: string): void {
  const line = "─".repeat(Math.max(title.length, 12));
  console.log(`\n${line}\n${title}\n${line}`);
}

/** Pretty-print a value as compact, indented JSON for the console. */
export function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** Truncate long text for previews and error messages. */
export function preview(value: unknown, max = 140): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length <= max ? text : `${text.slice(0, max)}...`;
}
