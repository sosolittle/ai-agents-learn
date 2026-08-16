import type { DataPaths } from "./config.js";
import { WorkflowEventSchema, type WorkflowEvent } from "./types.js";
import { nowIso, readJsonArray, writeJsonArray } from "./utils.js";

// The workflow event log. Every lifecycle event — created, started, resumed,
// each step's start/completion/failure, and every side-effect decision — is
// appended here, so there is a durable, ordered record of what actually
// happened, including the events a crash could never have produced.

export function loadEvents(paths: DataPaths): WorkflowEvent[] {
  return readJsonArray(paths.events, WorkflowEventSchema, "Events");
}

export function loadEventsForWorkflow(paths: DataPaths, workflowId: string): WorkflowEvent[] {
  return loadEvents(paths).filter((event) => event.workflowId === workflowId);
}

/**
 * Append a workflow event, stamping the timestamp. The event is validated
 * before it is written so the log never drifts out of shape.
 */
export function appendEvent(
  paths: DataPaths,
  event: Omit<WorkflowEvent, "timestamp">
): WorkflowEvent {
  const stored = WorkflowEventSchema.parse({ ...event, timestamp: nowIso() });
  const events = loadEvents(paths);
  events.push(stored);
  writeJsonArray(paths.events, events);
  return stored;
}
