import type { DataPaths } from "./config.js";
import { WorkflowRecordSchema, type WorkflowRecord } from "./types.js";
import { nextSequentialId, readJsonArray, writeJsonArray } from "./utils.js";

// Persistence for workflow checkpoints. This answers "where did the workflow
// get to?" — a plain JSON-file store keeps the example in scope: a running
// workflow survives a process restart, but there is no database to set up.
// All functions take a DataPaths so tests can point at temporary files.

export function loadWorkflows(paths: DataPaths): WorkflowRecord[] {
  return readJsonArray(paths.workflows, WorkflowRecordSchema, "Workflows");
}

export function saveWorkflows(paths: DataPaths, records: WorkflowRecord[]): void {
  writeJsonArray(paths.workflows, records);
}

export function findWorkflow(paths: DataPaths, id: string): WorkflowRecord | undefined {
  return loadWorkflows(paths).find((record) => record.id === id);
}

/**
 * Find the workflow already created for an approval, if any. This is the
 * anchor for workflow-start idempotency: the approval ID is the business
 * identity of the authorized action, so one approval should map to at most
 * one workflow, however many times its submission is retried.
 */
export function findWorkflowByApprovalId(
  paths: DataPaths,
  approvalId: string
): WorkflowRecord | undefined {
  return loadWorkflows(paths).find((record) => record.input.approvalId === approvalId);
}

/** Insert a new record or replace an existing one by ID. This is the checkpoint write. */
export function upsertWorkflow(paths: DataPaths, record: WorkflowRecord): void {
  const records = loadWorkflows(paths);
  const index = records.findIndex((existing) => existing.id === record.id);
  if (index === -1) {
    records.push(record);
  } else {
    records[index] = record;
  }
  saveWorkflows(paths, records);
}

export function nextWorkflowId(paths: DataPaths): string {
  return nextSequentialId(
    "WF",
    loadWorkflows(paths).map((record) => record.id)
  );
}
