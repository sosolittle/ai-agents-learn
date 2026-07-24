import type { DataPaths } from "./config.js";
import { AuditEventSchema, type AuditEvent } from "./types.js";
import { nowIso, readJsonArray, writeJsonArray } from "./utils.js";

// The audit trail. Every important lifecycle event is appended here so there is
// a durable, ordered record of what was proposed, gated, edited, decided, and
// executed — and by extension what was blocked. Keep secrets out of it; store
// tool names and IDs, not credentials.

export function loadAudit(paths: DataPaths): AuditEvent[] {
  return readJsonArray(paths.audit, AuditEventSchema, "Audit log");
}

/**
 * Append an audit event, stamping the timestamp. Returns the stored event.
 * The event is validated before it is written so the log never drifts out of
 * shape.
 */
export function appendAudit(
  paths: DataPaths,
  event: Omit<AuditEvent, "timestamp">
): AuditEvent {
  const stored = AuditEventSchema.parse({ ...event, timestamp: nowIso() });
  const events = loadAudit(paths);
  events.push(stored);
  writeJsonArray(paths.audit, events);
  return stored;
}
