import type { DataPaths } from "./config.js";
import {
  ApprovalRecordSchema,
  ExecutionRecordSchema,
  type ApprovalRecord,
  type ExecutionRecord,
} from "./types.js";
import { nextSequentialId, readJsonArray, writeJsonArray } from "./utils.js";

// Persistence for approval records and execution records. A simple JSON-file
// store keeps the example in scope: a pending approval survives a process
// restart, but there is no database to set up. All functions take a DataPaths
// so tests can point at temporary files.

export function loadApprovals(paths: DataPaths): ApprovalRecord[] {
  return readJsonArray(paths.approvals, ApprovalRecordSchema, "Approvals");
}

export function saveApprovals(paths: DataPaths, records: ApprovalRecord[]): void {
  writeJsonArray(paths.approvals, records);
}

export function findApproval(
  paths: DataPaths,
  id: string
): ApprovalRecord | undefined {
  return loadApprovals(paths).find((record) => record.id === id);
}

/** Insert a new record or replace an existing one by ID, preserving the rest. */
export function upsertApproval(paths: DataPaths, record: ApprovalRecord): void {
  const records = loadApprovals(paths);
  const index = records.findIndex((existing) => existing.id === record.id);
  if (index === -1) {
    records.push(record);
  } else {
    records[index] = record;
  }
  saveApprovals(paths, records);
}

export function nextApprovalId(paths: DataPaths): string {
  return nextSequentialId(
    "APR",
    loadApprovals(paths).map((record) => record.id)
  );
}

export function loadExecutions(paths: DataPaths): ExecutionRecord[] {
  return readJsonArray(paths.executions, ExecutionRecordSchema, "Executions");
}

export function saveExecution(paths: DataPaths, execution: ExecutionRecord): void {
  const executions = loadExecutions(paths);
  executions.push(execution);
  writeJsonArray(paths.executions, executions);
}

export function nextExecutionId(paths: DataPaths): string {
  return nextSequentialId(
    "EXE",
    loadExecutions(paths).map((execution) => execution.id)
  );
}

/**
 * Next result ID for a tool (e.g. "REF-001" for refunds), derived from the
 * existing executions of that same tool so the sequence is deterministic.
 */
export function nextResultId(
  paths: DataPaths,
  prefix: string,
  toolName: ExecutionRecord["toolName"]
): string {
  const resultIds = loadExecutions(paths)
    .filter((execution) => execution.toolName === toolName)
    .map((execution) => String(execution.result.refundId ?? execution.result.cancellationId ?? ""));
  return nextSequentialId(prefix, resultIds);
}
