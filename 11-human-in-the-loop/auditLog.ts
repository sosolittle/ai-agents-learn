// ============================================================
//  第十一章：审计日志（auditLog.ts）
//  记录"发生过什么"的追加式时间线
//
//  🏠 生活化比喻：大厅角落的「监控室黑匣子」。摄像头只录不剪：
//  每一帧按时间追加，连"有人想闯门被拦下"也要录上一笔。
//  出了纠纷，回放录像就能还原全过程；而录像一旦可剪辑，
//  它作为证据的资格就没了——所以本模块连"删除"按钮都没有。
//
//  学习目标：
//  1. 区分审计历史（append-only）与审批当前状态（可更新）
//  2. 为提案、策略、编辑、决定和执行保留完整因果链
//  3. 写入前校验事件结构，避免日志格式逐渐漂移
//  4. 理解"timestamp 由应用盖章"的安全意义
//
//  本文件在整个章节中的角色：
//  它是整条控制链的"飞行记录仪"。approvalService、executor
//  在每个关键节点调 appendAudit 留痕。出问题时（或复盘时），
//  `npm run audit` 能还原出完整的决策时间线：
//  谁提的案、策略怎么判、人改了什么、谁批的、工具跑没跑、
//  以及——同样重要——什么被阻止了。
//
//  注意：审计日志只追加，不提供任何修改/删除接口。
//  这不是偷懒：可编辑的审计日志没有证据力。
// ============================================================

import type { DataPaths } from "./config.js";
// DataPaths 里有 audit 字段指向 audit-log.json（见 config.ts）。
import { AuditEventSchema, type AuditEvent } from "./types.js";
// 十种事件类型与事件结构都在 types.ts 里定义。
import { nowIso, readJsonArray, writeJsonArray } from "./utils.js";
// 通用 JSON 存储工具（见 utils.ts 注释）。

// 审计时间线。每个重要的生命周期事件都追加到这里，
// 这样就有一份持久的、有序的记录：什么被提案、被策略判定、
// 被编辑、被决定、被执行——以及由此推出什么被阻止。
// 不要把机密放进来；存工具名和 ID，不存凭据。
//
// "以及由此推出什么被阻止"值得展开：
//   审计日志的一半价值在于记录"未遂事件"：
//     - ACTION_DENIED           → 策略拦下的危险提案
//     - DUPLICATE_EXECUTION_BLOCKED → 拦下的重复执行
//   只有成功记录的日志是"成绩单"；
//   成功 + 拦截都记录的日志才是"完整的安全记录"。
//   如果某天有人试图让 agent 删生产用户，日志里会留下一声 ACTION_DENIED——
//   这正是安全团队最想第一时间看到的信号。

export function loadAudit(paths: DataPaths): AuditEvent[] {
  // 读全部事件（含校验）。CLI 的 audit 命令用它打印时间线。
  return readJsonArray(paths.audit, AuditEventSchema, "Audit log");
}

/**
 * 追加一个审计事件，并自动盖上时间戳。返回存储后的事件。
 * 事件在写入前经过校验，日志的形状永远不会漂移。
 */
export function appendAudit(
  paths: DataPaths,
  event: Omit<AuditEvent, "timestamp">
): AuditEvent {
  // 参数类型 Omit<AuditEvent, "timestamp"> 是本函数的精髓：
  //
  //   Omit<T, K> 是 TypeScript 的工具类型（utility type），
  //   含义是"类型 T 去掉 K 字段后的新类型"。
  //
  //   调用方传入的事件对象里【不允许】有 timestamp 字段
  //   （多传会因对象字面量的多余属性检查报错），
  //   timestamp 只能由本函数在下一行盖章补上。
  //
  //   用类型系统强制"谁负责什么"：
  //   时间戳必须由应用生成，而不是信任调用方传入——
  //   1. 保证所有事件的时间格式严格一致（都是 nowIso() 的 ISO 格式）
  //   2. 调用方无法伪造或传错时间（时区、格式、时钟漂移）
  //   同样的手法见 eventLog.ts（第 12 章）和 types.ts 里
  //   "timestamp 由 appendAudit 盖章"的注释。
  const stored = AuditEventSchema.parse({ ...event, timestamp: nowIso() });
  // 三步合一：
  //   展开 event → 补上应用生成的 timestamp → 整体过 Schema 校验
  // parse（而非 safeParse）直接抛错是合理的：
  //   事件结构错误是编程 bug（不是用户输入问题），
  //   让它大声崩溃比静默吞掉好。
  const events = loadAudit(paths);
  events.push(stored);
  // 追加到末尾——时间线的顺序就是写入顺序。
  // 不排序、不插入、不去重：日志的真实性来自"从不修饰"。
  writeJsonArray(paths.audit, events);
  return stored;
  // 返回盖好章、验过型的完整事件。
  // 返回值让调用方（尤其是测试）能拿到最终形态，
  // 而不用猜 timestamp 补成了什么。
}

// ============================================================
//  本文件小结：审计三原则
// ============================================================
//
// 1. 只追加，不修改。
//    本模块只有 load 和 append，没有任何 update/delete——
//    能被改写的日志没有证据价值。
//
// 2. 连"被阻止的事"也记录。
//    deny、重复拦截、崩溃恢复都有专属事件类型，
//    未遂事件和既遂事件同样重要。
//
// 3. 关键字段由应用生成。
//    Omit<AuditEvent, "timestamp"> 从类型上禁止调用方自带时间戳。
//
// 第 12 章的 eventLog.ts 是同一个思想的变体：
// 那里记录的是工作流生命周期事件，供恢复与观测使用。
// ============================================================
