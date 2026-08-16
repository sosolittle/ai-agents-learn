// Small helpers shared across the module: JSON-file persistence, ID
// generation, and console formatting. No model output to parse here — this
// module makes zero OpenAI calls.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

/**
 * Read a JSON array store from disk.
 *
 * - a missing file is treated as an empty store (returns [])
 * - an empty file is treated as an empty store (returns [])
 * - malformed JSON throws a clear, labelled error instead of silently
 *   resetting the data — losing checkpoint or ledger history quietly is worse
 *   than failing
 * - the parsed data is validated against the item schema
 */
export function readJsonArray<T>(
  filePath: string,
  schema: z.ZodType<T>,
  label: string
): T[] {
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
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(items, null, 2)}\n`, "utf8");
}

/**
 * Next deterministic sequential ID for a prefix (e.g. "WF" -> "WF-001").
 * Derived from the highest existing suffix so IDs stay stable and never
 * collide, even if some records were removed.
 */
export function nextSequentialId(prefix: string, existingIds: string[]): string {
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
