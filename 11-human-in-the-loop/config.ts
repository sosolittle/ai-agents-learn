import OpenAI from "openai";
import path from "node:path";
import { fileURLToPath } from "node:url";

// One place for the model settings. Proposing an action is a small,
// deterministic classification job, so the temperature is 0 and the token
// budget is low — the model's output is a typed proposal, not prose.
export const MODEL = "gpt-4o-mini";
export const MAX_TOKENS = 400;
export const TEMPERATURE = 0;

// Resolve the data directory relative to this file, not the current working
// directory, so the CLI commands work the same whether they are run from inside
// the module folder or from the repo root. path.join keeps this correct on
// Windows too.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.join(__dirname, "data");

// The persisted workflow state. Approval records survive process restarts, so a
// pending approval is a durable thing to act on later — not just an in-memory
// readline question.
export interface DataPaths {
  approvals: string;
  audit: string;
  executions: string;
}

/** The committed demonstration stores. Tests inject temporary paths instead. */
export function defaultPaths(): DataPaths {
  return {
    approvals: path.join(DATA_DIR, "approvals.json"),
    audit: path.join(DATA_DIR, "audit-log.json"),
    executions: path.join(DATA_DIR, "executions.json"),
  };
}

let _client: OpenAI | null = null;

export function getClient(): OpenAI {
  if (!_client) {
    _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _client;
}
