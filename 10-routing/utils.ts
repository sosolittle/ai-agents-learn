// ============================================================
//  第十章 utils：路由模块共用工具
//
//  学习目标：
//  1. 复用 JSON parse + Zod 校验逻辑
//  2. 用清晰错误暴露坏的路由输出
//  3. 保持 index/routerAgent/handlers 文件更专注自己的职责
// ============================================================

// Small helpers shared across the module.
//
// The JSON parsing here validates the router's output against a Zod schema so
// that a malformed decision fails loudly at the boundary. Parse the JSON, then
// confirm its shape matches the contract; otherwise throw a clear error.

import { z } from "zod";

/**
 * Parse a model response that is expected to match a Zod schema.
 * Throws a clear, labelled error if the text is not valid JSON or does not
 * match the schema, so a bad routing decision is easy to spot.
 */
export function safeJsonParse<T>(
  raw: string,
  label: string,
  schema: z.ZodType<T>
): T {
  // Router 是模型输出，不能直接信任。
  // 这一步把“看起来像 JSON 的文本”变成经过 schema 验证的对象。
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `${label} did not return valid JSON. Got:\n${preview(raw, 200)}`
    );
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `${label} returned invalid shape.\n${result.error.toString()}\nRaw:\n${preview(raw, 200)}`
    );
  }

  return result.data;
}

/** Print a labelled section header so each request is easy to read in the console. */
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
