// ============================================================
//  第十二章：checkpoint 存储（checkpointStore.ts）
//  "工作流走到哪了"的持久化答案
//
//  🏠 生活化比喻：剧场后台的「进度白板」。每演完一幕，场记就把
//  白板上的清单多勾一项（upsert = 擦掉旧板重写整块新板）；
//  断电重开后，导演看一眼白板就知道"下一幕从哪演"。
//  白板只写当前进度、不保留历史草稿——历史在另一个柜子里
//  （events.json 那卷录像带）。白板最怕被涂改成"跳步"的假进度，
//  所以每次开灯读板都要先验格式（superRefine 把关）。
//
//  学习目标：
//  1. 对比 effectStore（账本）：两个存储一个字之差，
//     职责却完全不同——checkpoint 是可更新的进度，
//     账本是只追加的事实
//  2. 理解 upsert 即 checkpoint 写入：
//     每次"步骤完成"就是一次整记录覆盖
//  3. 认识 findWorkflowByApprovalId——
//     工作流启动幂等的锚点
//
//  本文件在整个章节中的角色：
//  它是 runner 的进度条。workflowRunner 每完成一个步骤
//  就调 upsertWorkflow 写一次新版本记录；恢复时
//  findWorkflow 从磁盘重读。文件很薄——
//  因为 types.ts 的 superRefine 已经把"什么是合法记录"
//  管起来了，这里只剩最朴素的存取。
// ============================================================

import type { DataPaths } from "./config.js";
import { WorkflowRecordSchema, type WorkflowRecord } from "./types.js";
// WorkflowRecordSchema 自带 superRefine（前缀不变量、
// context 一致性、completed 诚实性）——
// 下面的 loadWorkflows 每次读取都会全量执行它们。
import { nextSequentialId, readJsonArray, writeJsonArray } from "./utils.js";

// 工作流 checkpoint 的持久化。它回答"工作流走到哪了？"——
// 一个普通的 JSON 文件存储让示例保持可控：一个运行中的
// 工作流能在进程重启后幸存，又不需要装任何数据库。
// 所有函数都接收 DataPaths，这样测试可以指向临时文件。

export function loadWorkflows(paths: DataPaths): WorkflowRecord[] {
  // 读时校验的全部重量都压在这一个调用上：
  //
  //   readJsonArray 内部会跑 WorkflowRecordSchema =
  //   基础 Shape（字段/类型/strict）+ superRefine（语义不变量）
  //
  // 所以"乱序的 completedSteps""谎报 completed 的状态"
  // 这类被污染的 checkpoint，在 loadWorkflows 这一刻就抛错——
  // 恢复逻辑（workflowRunner）永远只会看到合法记录。
  // 把校验放在读取边界，下游代码就不需要"防御性检查"
  // 散落各处：入口干净，处处干净。
  return readJsonArray(paths.workflows, WorkflowRecordSchema, "Workflows");
}

export function saveWorkflows(paths: DataPaths, records: WorkflowRecord[]): void {
  // 整组覆盖写（与 11 章 saveApprovals 同款）。
  writeJsonArray(paths.workflows, records);
}

export function findWorkflow(paths: DataPaths, id: string): WorkflowRecord | undefined {
  // 按 ID 查单条。resumeWorkflow / CLI 的 status 命令都用它。
  return loadWorkflows(paths).find((record) => record.id === id);
}

/**
 * 查找已经为某个审批创建过的工作流（如果有）。
 * 这是工作流启动幂等的锚点：审批 ID 是已授权动作的
 * 业务身份，所以一个审批最多映射到一个工作流，
 * 无论它的提交被重试多少次。
 */
export function findWorkflowByApprovalId(
  paths: DataPaths,
  approvalId: string
): WorkflowRecord | undefined {
  // 本章两条幂等边界的第一条就锚在这里：
  //
  //   边界 A（本函数服务）：工作流启动幂等
  //     APR-001 → 至多一个 WF
  //     防的是"重复提交变成重复工作流"
  //     （重复点击 / 重试请求 / npm start 跑两次）
  //
  //   边界 B（effectStore 服务）：步骤执行幂等
  //     WF-001:execute_refund → 至多一个 REF
  //     防的是"同一工作流内的步骤重试重复副作用"
  //
  // 两个边界防的重复路径不同，少任何一个都会双倍退款：
  //   缺 A：npm start 两次 → WF-001 和 WF-002，
  //         各自持有"合法"的幂等键，两条合法退款
  //   缺 B：崩溃恢复重跑 execute_refund → 第二条退款
  return loadWorkflows(paths).find((record) => record.input.approvalId === approvalId);
}

/** 按 ID 插入新记录或替换已有记录。这就是 checkpoint 写入。 */
export function upsertWorkflow(paths: DataPaths, record: WorkflowRecord): void {
  // 注释里那句"这就是 checkpoint 写入"值得停下来体会：
  //
  // "checkpoint"听起来是个机制，实际就是——
  //   把带新 completedSteps 的整条记录写回 JSON 文件。
  // 没有快照、没有日志、没有增量：每次覆盖整条记录。
  //
  // 为什么整条覆盖就够？
  //   记录本身不大（几十行 JSON），
  //   completedSteps 只增不改（前缀不变量），
  //   覆盖写 + 读时校验 = 简单且自洽。
  //   Temporal 那类框架用的是"事件溯源 + 重放"，
  //   那是更高阶的方案，思想内核反而一致：
  //   持久化"确定发生了的事"，推导"现在在哪"。
  const records = loadWorkflows(paths);
  const index = records.findIndex((existing) => existing.id === record.id);
  if (index === -1) {
    records.push(record);
  } else {
    records[index] = record;
    // 原位替换：新版本的 completedSteps/context/status
    // 整体取代旧版本。旧版本不复存在（没有历史版本链）——
    // "历史"这个角色由 events.json 的事件日志承担。
  }
  saveWorkflows(paths, records);
}

export function nextWorkflowId(paths: DataPaths): string {
  // "WF-001"、"WF-002"...（"最大后缀 + 1"算法见 utils.ts）。
  //
  // 注意 nextWorkflowId 只在 findWorkflowByApprovalId
  // 确认没有既有工作流之后才被调用（见 workflowRunner.createWorkflow）——
  // 重复提交连新 ID 都不会消耗。
  return nextSequentialId(
    "WF",
    loadWorkflows(paths).map((record) => record.id)
  );
}

// ============================================================
//  本文件小结：两本账的对照（终版）
// ============================================================
//
// | 维度      | workflows.json（本文件） | effects.json（effectStore）|
// |-----------|--------------------------|----------------------------|
// | 写入方式  | upsert（覆盖更新）        | append（只追加）           |
// | 记录含义  | "我现在到哪了"            | "这件事发生过"             |
// | 崩溃语义  | 可能滞后（窗口所在）       | 权威事实（恢复的锚点）     |
// | 校验重点  | 前缀/一致性/诚实性        | 键唯一/类型配对            |
//
// 恢复的口诀：拿账本（权威）修 checkpoint（滞后），
// 而不是拿 checkpoint 猜账本。
// ============================================================
