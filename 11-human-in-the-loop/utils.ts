// ============================================================
//  Utilities：校验边界、JSON 持久化、ID 与终端输出
//
//  学习目标：
//  1. 将“解析 JSON”和“验证业务结构”作为两个明确步骤
//  2. 数据损坏时快速失败，不静默清空审批或审计记录
//  3. 用确定性顺序 ID 让演示输出容易观察和测试
// ============================================================
//
// Small helpers shared across the module: model-output validation, JSON-file
// persistence, ID generation, and console formatting.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

/**
 * Parse a model response that is expected to match a Zod schema.
 * Throws a clear, labelled error if the text is not valid JSON or does not
 * match the schema, so a bad proposal fails loudly at the boundary.
 */
export function safeJsonParse<T>(
  raw: string,
  label: string,
  schema: z.ZodType<T>
): T {
  // parsed 必须先保持 unknown；只有通过 schema 后才能成为 T。
  // 直接写 `JSON.parse(raw) as T` 只是在骗过编译器，没有运行时保护。
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

/**
 * Read a JSON array store from disk.
 *
 * - a missing file is treated as an empty store (returns [])
 * - an empty file is treated as an empty store (returns [])
 * - malformed JSON throws a clear, labelled error instead of silently
 *   resetting the data — losing an audit trail quietly is worse than failing
 * - the parsed data is validated against the item schema
 */
export function readJsonArray<T>(
  filePath: string,
  schema: z.ZodType<T>,
  label: string
): T[] {
  // 缺失文件表示“尚无数据”，但已存在却损坏的文件表示真实故障；
  // 两者不能都返回 []，否则会静默丢失审批和审计历史。
  if (!existsSync(filePath)) return [];

  const raw = readFileSync(filePath, "utf8").trim();
  if (raw === "") return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `${label} store at ${filePath} contains malformed JSON. ` +
        `Fix it by hand or restore a clean state with "npm run reset".`
    );
  }

  const result = z.array(schema).safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `${label} store at ${filePath} has an invalid shape.\n${result.error.toString()}`
    );
  }

  return result.data;
}

/** Write a JSON array store to disk as formatted JSON, creating the folder if needed. */
export function writeJsonArray<T>(filePath: string, items: T[]): void {
  // 统一格式化并补换行，让持久化文件可以直接阅读和进行 git diff。
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(items, null, 2)}\n`, "utf8");
}

/**
 * Next deterministic sequential ID for a prefix (e.g. "APR" -> "APR-001").
 * Derived from the highest existing suffix so IDs stay stable and never collide,
 * even if some records were removed.
 */
export function nextSequentialId(prefix: string, existingIds: string[]): string {
  // 取最大后缀而不是数组长度：即使中间记录被移除，也不会重用旧 ID。
  const pattern = new RegExp(`^${prefix}-(\\d+)$`);
  let max = 0;
  for (const id of existingIds) {
    const match = id.match(pattern);
    if (match) max = Math.max(max, Number.parseInt(match[1], 10));
  }
  return `${prefix}-${String(max + 1).padStart(3, "0")}`;
}

/** Current time as an ISO string, used for createdAt/updatedAt/timestamps. */
export function nowIso(): string {
  return new Date().toISOString();
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
