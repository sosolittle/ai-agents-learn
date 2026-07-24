// ============================================================
//  Audit Log：记录“发生过什么”的追加式时间线
//
//  学习目标：
//  1. 区分审计历史与审批当前状态
//  2. 为提案、策略、编辑、决定和执行保留因果链
//  3. 写入前校验事件结构，避免日志格式逐渐漂移
// ============================================================

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
  // timestamp 由应用生成，而不是信任调用方传入，保证所有事件使用一致格式。
  const stored = AuditEventSchema.parse({ ...event, timestamp: nowIso() });
  const events = loadAudit(paths);
  events.push(stored);
  writeJsonArray(paths.audit, events);
  return stored;
}
