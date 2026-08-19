// ============================================================
//  第十一章：审批存储（approvalStore.ts）
//  用 JSON 文件保存可恢复的工作流状态与执行事实
//
//  学习目标：
//  1. 区分 approval record（流程状态，可更新）与
//     execution record（执行事实，只追加）
//  2. 理解为什么 pending 必须持久化，不能只放在进程内存里
//  3. 用依赖注入的 DataPaths 隔离演示数据和测试数据
//  4. 用持久化的 execution 记录作为本地幂等依据
//
//  本文件在整个章节中的角色：
//  它是 approvalService / executor / cli 的共同后端。
//  所有函数都是"读文件 → 处理 → 写回整个文件"的朴素模式，
//  没有数据库、没有锁——这是刻意为之的教学简化，
//  但"审批状态和执行事实分开存"的结构决策即使在
//  数据库版里也原样保留。
// ============================================================

import type { DataPaths } from "./config.js";
// DataPaths：三个 JSON 文件路径的接口（见 config.ts 注释）。
// 本文件所有函数的第一个参数都是它——测试注入临时目录，
// 演示用默认目录，函数本身不关心路径从哪来。
import {
  ApprovalRecordSchema,
  ExecutionRecordSchema,
  type ApprovalRecord,
  type ExecutionRecord,
} from "./types.js";
// 读取时会用这两个 Schema 校验整份数据（防损坏/防手改坏）。
import { nextSequentialId, readJsonArray, writeJsonArray } from "./utils.js";
// 通用 JSON 存储与 ID 生成工具（见 utils.ts 注释）。

// 审批记录与执行记录的持久化。一个简单的 JSON 文件存储
// 让示例保持可控：一张 pending 审批单能在进程重启后幸存，
// 而且不需要安装任何数据库。所有函数都接收 DataPaths，
// 这样测试可以指向临时文件。
//
// 两个 store 的本质区别（这是本文件最重要的思想）：
//   approvals.json → 状态存储（state）：
//     记录"现在怎么样"，可以被 upsert 原地更新
//     （pending → approved → executed 就是三次原地改写）
//   executions.json → 事实日志（fact log）：
//     记录"发生过什么"，只追加、永不修改
//     （一次执行就是一条记录，天塌了也不改它）
// 状态可以反悔（驳回后重新申请是新记录），事实不能反悔
// （退款发生过就是发生过）。两种数据混在一个文件里，
// 就分不清哪些字段能改哪些不能改了。

export function loadApprovals(paths: DataPaths): ApprovalRecord[] {
  // 每次读取都会通过 ApprovalRecordSchema 验证整个数组，
  // 损坏或过期的数据会明确报错，而不是悄悄当成空列表。
  //
  // "每次读都校验"看起来浪费，其实是 JSON 存储模式的必需品：
  //   文件可能被手改、被别的进程写坏、被旧版本代码写过。
  //   读时校验 = 把"数据可信"的假设变成"数据已验证"的事实。
  //   每次多花不到一毫秒，换来整条链路不需要再怀疑数据。
  return readJsonArray(paths.approvals, ApprovalRecordSchema, "Approvals");
}

export function saveApprovals(paths: DataPaths, records: ApprovalRecord[]): void {
  // 整个数组一次性写回（覆盖写）。
  // 注意本模块的外部 API 基本不暴露 saveApprovals 给业务层用——
  // 业务层用 upsertApproval，保证"改一条不动其他"。
  writeJsonArray(paths.approvals, records);
}

export function findApproval(
  paths: DataPaths,
  id: string
): ApprovalRecord | undefined {
  // .find(谓词)：返回第一个满足条件的元素；没有则 undefined。
  // 返回 undefined 而不是 null/抛错，是"查询类函数"的惯例：
  // "没找到"是正常结果，让调用方决定要不要把它当错误。
  return loadApprovals(paths).find((record) => record.id === id);
}

/** 按 ID 插入一条新记录或替换已有记录，其余保持不变。 */
export function upsertApproval(paths: DataPaths, record: ApprovalRecord): void {
  // upsert = update + insert：
  //   已存在同 ID 的记录 → 原地替换
  //   不存在             → 追加到末尾
  // 同一个审批 ID 在状态迁移时原位更新；其他审批记录保持顺序和内容不变。
  const records = loadApprovals(paths);
  const index = records.findIndex((existing) => existing.id === record.id);
  // findIndex：找到返回下标，找不到返回 -1（注意不是 undefined/null）。
  if (index === -1) {
    records.push(record);
  } else {
    records[index] = record;
    // 整条替换而不是 Object.assign 合并：
    // 状态迁移产生的是"完整的新记录"，替换语义最清晰，
    // 不会残留旧记录里已被删掉的字段。
  }
  saveApprovals(paths, records);
}

export function nextApprovalId(paths: DataPaths): string {
  // "APR" + 现有最大序号 + 1 → "APR-001"、"APR-002"...
  // nextSequentialId 的实现（含"为什么取最大值而不是长度"）见 utils.ts。
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
  //
  // 对比上面 approvals 的 saveApprovals（整组覆盖）和 upsert（可替换），
  // 这里只有 push（追加）——API 形状本身就编码了语义：
  //   状态存储 → 提供更新接口
  //   事实存储 → 只提供追加接口
  // 想改一条执行记录？没有函数支持你，得手改文件（然后被校验逮住）。
  // "让做错事变难"的接口设计。
  const executions = loadExecutions(paths);
  executions.push(execution);
  writeJsonArray(paths.executions, executions);
}

/**
 * 查找某个审批已经记录过的执行（如果有）。
 *
 * 这是本地幂等的锚点：执行记录是"工具已为这个审批运行过"的
 * 持久证据。如果进程死在"执行已保存"之后、"审批翻到 executed"
 * 之前，这个函数让重试恢复已有结果，而不是再跑一次工具。
 */
export function findExecutionByApprovalId(
  paths: DataPaths,
  approvalId: string
): ExecutionRecord | undefined {
  // 恢复场景复现（README 里也有这条时间线）：
  //
  //   pending
  //     ↓ 人工批准并落盘                → approvals: approved
  //     ↓ 工具成功，ExecutionRecord 落盘 → executions: EXE-001
  //     💥 进程在更新 ApprovalRecord 之前崩溃
  //
  //   重试 approve 时：
  //     record.status 还是 "approved"
  //     但 findExecutionByApprovalId(paths, "APR-001") 查到了 EXE-001
  //     → 复用结果，把状态补成 executed，不再退款
  //
  // "以事实（execution）为准修复状态（approval）"，
  // 而不是反过来——因为事实不会说谎，状态可能滞后。
  return loadExecutions(paths).find(
    (execution) => execution.approvalId === approvalId
  );
}

export function nextExecutionId(paths: DataPaths): string {
  // "EXE-001"、"EXE-002"...，和审批单号同样的生成规则。
  return nextSequentialId(
    "EXE",
    loadExecutions(paths).map((execution) => execution.id)
  );
}

/**
 * 某个工具的下一个结果 ID（例如退款的 "REF-001"），
 * 从同一工具的既有执行推导，保证序号确定性。
 */
export function nextResultId(
  paths: DataPaths,
  prefix: string,
  toolName: ExecutionRecord["toolName"]
): string {
  // 参数类型 ExecutionRecord["toolName"] 是"索引访问类型"：
  // 直接取 ExecutionRecord 类型里 toolName 字段的类型
  // （也就是 ToolName 联合）。不 import ToolName 也能引用它，
  // 而且若 ExecutionRecord 的字段类型变了，这里自动跟着变。
  //
  // 只从同一工具的历史结果推导序号，避免退款 REF 与取消 CAN 相互影响。
  // 想象不按工具过滤：两笔退款 + 一笔取消共用一个计数器，
  // REF-001, REF-002, CAN-003, REF-004——退款单号出现空洞，
  // 对账时像丢过数据一样可疑。按工具分开计数，
  // REF 永远连续，CAN 永远连续。
  const resultIds = loadExecutions(paths)
    .filter((execution) => execution.toolName === toolName)
    .map((execution) => String(execution.result.refundId ?? execution.result.cancellationId ?? ""));
    // ?? 链式兜底：先取 refundId，没有再取 cancellationId，
    // 都没有给空串。因为已经按 toolName 过滤，
    // 退款记录必有 refundId、取消记录必有 cancellationId，
    // 最后的 ?? "" 只是让类型从 unknown 收窄到 string。
  return nextSequentialId(prefix, resultIds);
}

// ============================================================
//  本文件小结：状态 vs 事实
// ============================================================
//
// | 维度        | approvals.json      | executions.json   |
// |-------------|---------------------|-------------------|
// | 回答什么    | 现在走到哪一步       | 什么真的发生过     |
// | 写入方式    | upsert（可替换）     | append（只追加）   |
// | 谁写入      | approvalService     | executor          |
// | 幂等角色    | 记录 duplicatedOf 等 | 崩溃恢复的锚点     |
//
// 崩溃恢复永远"以事实修状态"：execution 存在 ⇒ 工具已运行 ⇒
// 补齐 approval 状态即可，绝不重跑工具。
//
// 下一站：executor.ts 看"事实"是怎么被安全地写下的。
// ============================================================
