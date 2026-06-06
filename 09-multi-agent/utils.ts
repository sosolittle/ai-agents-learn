// Small helpers shared across the agents.
//
// The JSON parsing here is intentionally defensive but minimal. A production
// system would validate each agent's output against a schema (for example with
// Zod or JSON Schema) so that a malformed handoff fails loudly at the boundary.
// This module keeps dependencies minimal, so we do a narrow check: parse the
// JSON, confirm it is an object, and throw a clear error otherwise.

/**
 * Parse a model response that is expected to be a JSON object.
 * Throws a clear, labelled error if the text is not valid JSON or is not an
 * object, so a bad handoff between agents is easy to spot.
 */
export function safeJsonParse<T>(raw: string, agentName: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `${agentName} did not return valid JSON. Got:\n${preview(raw, 200)}`
    );
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `${agentName} returned JSON that is not an object. Got:\n${preview(raw, 200)}`
    );
  }

  // We trust the shape here for teaching purposes. In production this is where
  // a schema validator would confirm every field exists and has the right type.
  return parsed as T;
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
