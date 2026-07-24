// ============================================================
//  Approval Store：用 JSON 文件保存可恢复的工作流状态
//
//  学习目标：
//  1. 区分 approval record（流程状态）与 execution record（执行事实）
//  2. 理解为什么 pending 必须持久化，不能只放在当前进程内存中
//  3. 用依赖注入的 DataPaths 隔离演示数据和测试数据
//  4. 用持久化 execution 记录作为本地幂等依据
// ============================================================

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
  // 每次读取都会通过 ApprovalRecordSchema 验证整个数组，
  // 损坏或过期的数据会明确报错，而不是悄悄当成空列表。
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
  // 同一个审批 ID 在状态迁移时原位更新；其他审批记录保持顺序和内容不变。
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
  // execution 是已经发生的事实，只追加、不覆盖。
  const executions = loadExecutions(paths);
  executions.push(execution);
  writeJsonArray(paths.executions, executions);
}

/**
 * Find an execution already recorded for an approval, if any.
 *
 * This is the anchor for local idempotency: the execution record is the durable
 * proof that a tool already ran for this approval. If the process died after the
 * execution was saved but before the approval flipped to `executed`, this lets a
 * retry recover the existing result instead of running the tool again.
 */
export function findExecutionByApprovalId(
  paths: DataPaths,
  approvalId: string
): ExecutionRecord | undefined {
  return loadExecutions(paths).find(
    (execution) => execution.approvalId === approvalId
  );
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
  // 只从同一工具的历史结果推导序号，避免退款 REF 与取消 CAN 相互影响。
  const resultIds = loadExecutions(paths)
    .filter((execution) => execution.toolName === toolName)
    .map((execution) => String(execution.result.refundId ?? execution.result.cancellationId ?? ""));
  return nextSequentialId(prefix, resultIds);
}
