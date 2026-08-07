import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ApprovedAction } from "./types.js";

// Resolve the data directory relative to this file, not the current working
// directory, so the CLI commands work the same whether they are run from
// inside the module folder or from the repo root.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.join(__dirname, "data");

// The persisted checkpoint, effect ledger, and event log. Tests inject
// temporary paths instead so the committed demo files are never touched.
export interface DataPaths {
  workflows: string;
  effects: string;
  events: string;
}

/** The committed demonstration stores. */
export function defaultPaths(): DataPaths {
  return {
    workflows: path.join(DATA_DIR, "workflows.json"),
    effects: path.join(DATA_DIR, "effects.json"),
    events: path.join(DATA_DIR, "events.json"),
  };
}

// This is where Module 12 begins: the refund Module 11 already approved.
// There is no model call anywhere in this module — durable execution starts
// after a proposal has already been authorized by the previous control layer.
export const DEMO_APPROVED_ACTION: ApprovedAction = {
  approvalId: "APR-001",
  status: "approved",
  toolName: "refundOrder",
  arguments: {
    orderId: "ORD-001",
    amount: 49,
    currency: "EUR",
    reason: "Partial refund approved after review",
  },
};
