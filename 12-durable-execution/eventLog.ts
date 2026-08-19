// ============================================================
//  第十二章：事件日志（eventLog.ts）
//  工作流生命周期的追加式时间线
//
//  学习目标：
//  1. 看懂事件日志与 checkpoint 的分工：
//     checkpoint 是"现状"，事件日志是"编年史"
//  2. 复用 11 章审计日志的三原则（只追加/未遂也记/应用盖章）
//  3. 理解"崩溃产生不了的事件"的取证价值
//
//  本文件在整个章节中的角色：
//  它是 runner 的"黑匣子"。每次 npm run events 都能还原
//  完整时间线——包括崩溃前后各发生了什么。
//  它不参与任何控制流决策：删掉它，恢复照样工作；
//  留着它，你能解释恢复为什么那样工作。
// ============================================================

import type { DataPaths } from "./config.js";
import { WorkflowEventSchema, type WorkflowEvent } from "./types.js";
import { nowIso, readJsonArray, writeJsonArray } from "./utils.js";

// 工作流事件日志。每个生命周期事件——创建、启动、恢复、
// 每个步骤的开始/完成/失败、以及每次副作用决策——
// 都追加到这里，所以有一份持久的、有序的记录，
// 记录实际发生了什么，包括崩溃永远产生不了的事件。

// "崩溃产生不了的事件"是什么意思？
//   STEP_COMPLETED 永远不可能在崩溃瞬间写入——
//   写它的代码来不及运行。
//   所以时间线上"有 STEP_STARTED、没有 STEP_COMPLETED"的缺口
//   本身就是崩溃的证据：
//
//   ... STEP_STARTED execute_refund
//       SIDE_EFFECT_EXECUTED execute_refund     ← 副作用发生了
//   （崩溃：没有 STEP_COMPLETED）                ← 缺口 = 崩溃现场
//   ... WORKFLOW_RESUMED                         ← 新进程接手
//       STEP_STARTED execute_refund             ← 步骤重跑
//       SIDE_EFFECT_REUSED execute_refund       ← 幂等键命中！
//       STEP_COMPLETED execute_refund           ← 这次checkpoint 成功
//
//   这七行就是整章故事的"行车记录仪"版本。
//   README"Example output"里的 events 列表正是它。

export function loadEvents(paths: DataPaths): WorkflowEvent[] {
  // 读全部事件（含 Schema 校验）。
  return readJsonArray(paths.events, WorkflowEventSchema, "Events");
}

export function loadEventsForWorkflow(paths: DataPaths, workflowId: string): WorkflowEvent[] {
  // 按工作流过滤。多工作流共存时（APR-001 和 APR-002 各一条），
  // events 命令只看指定工作流的时间线。
  return loadEvents(paths).filter((event) => event.workflowId === workflowId);
}

/**
 * 追加一个工作流事件，并自动盖上时间戳。
 * 事件在写入前经过校验，日志的形状永远不会漂移。
 */
export function appendEvent(
  paths: DataPaths,
  event: Omit<WorkflowEvent, "timestamp">
): WorkflowEvent {
  // 和 11 章 appendAudit 一模一样的手法：
  //
  //   Omit<WorkflowEvent, "timestamp">
  //   → 类型层面禁止调用方自带时间戳
  //   → timestamp 只能由本函数的 nowIso() 盖章
  //
  // 好处同样有二：格式统一（全部 ISO/UTC）、
  // 时间不可伪造（调用方无法塞假时间污染时间线）。
  // 两个章节的日志模块共用这一个模式——
  // "timestamp 由存储层盖章"可以直接抄进任何项目。
  const stored = WorkflowEventSchema.parse({ ...event, timestamp: nowIso() });
  // parse 而非 safeParse：事件结构错误是代码 bug，
  // 立刻崩溃比静默吞掉好。
  const events = loadEvents(paths);
  events.push(stored);
  // 追加到末尾：时间线顺序 = 写入顺序。
  writeJsonArray(paths.events, events);
  return stored;
}

// ============================================================
//  本文件小结
// ============================================================
//
// 事件日志三问三答：
//  Q: 它参与恢复决策吗？
//  A: 不。恢复只读 checkpoint + 账本。日志是给人看的。
//
//  Q: 为什么不拿事件日志重放出状态（事件溯源）？
//  A: 那是更强的架构，代价也更高（重放逻辑、版本兼容）。
//     本章把"状态"和"历史"分开存：
//     状态快速可查（upsert），历史追加可解释（append）。
//     事件溯源在两者之间搭了座桥，本演示不需要过桥。
//
//  Q: 它和 11 章审计日志什么关系？
//  A: 同一模式、不同视角：11 章记"审批生命周期"，
//     12 章记"工作流生命周期"。两份时间线在
//     APR-001 → WF-001 处可以互相印证。
// ============================================================
