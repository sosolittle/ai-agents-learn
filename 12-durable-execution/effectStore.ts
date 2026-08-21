// ============================================================
//  第十二章：副作用账本（effectStore.ts）
//  mock 下游提供方自己的幂等记录
//
//  🏠 生活化比喻：收银台那本「发票登记簿」。每张发票有个唯一编号
//  （幂等键 = 工作流:步骤），登记簿只往上添、从不撕页；
//  同一编号想登记第二次？收银员直接拍桌子报警
//  （appendEffect 抛错，宁可拒绝服务也不记糊涂账）。
//  它和进度白板（checkpointStore）是两本独立的账：
//  白板会因断电丢帧，登记簿跟着钱走——钱到哪它记到哪。
//
//  学习目标：
//  1. 理解幂等键（idempotency key）的构造：
//     workflowId + step → "WF-001:execute_refund"
//  2. 认清账本和 checkpoint 的分工：
//     checkpoint 回答"走到哪"，账本回答"做没做过"
//  3. 用 appendEffect 的"一键一记录"约束做最后防线
//  4. 正视 check-then-write 的并发局限（生产要用原子约束）
//
//  本文件在整个章节中的角色：
//  它扮演"下游提供方"（支付网关/邮件服务）自己的存储。
//  关键设定：幂等检查发生在提供方内部（steps.ts 的 provider 函数），
//  而不是 runner 外面套一层 if——
//  因为 runner 自己的簿记（completedSteps）恰恰是崩溃会污染的东西，
//  守门的位置必须在被污染数据之外。
// ============================================================

import type { DataPaths } from "./config.js";
import {
  EffectRecordSchema,
  type EffectRecord,
  type EffectType,
  type WorkflowStep,
} from "./types.js";
import { nextSequentialId, readJsonArray, writeJsonArray } from "./utils.js";

// 幂等副作用的持久化。这是 mock 下游提供方自己的账本——
// 它回答"如果这个步骤重试，能避免重复副作用吗？"，
// 这和"工作流走到哪了？"（checkpointStore.ts 的职责）
// 是两个不同的问题。工作流步骤可以被重放；
// 账本负责阻止业务副作用跟着重放一起重复发生。

/** 一个重试的步骤向 mock 提供方出示的幂等键。 */
export function idempotencyKey(workflowId: string, step: WorkflowStep): string {
  // 键的构造是本章的"暗线主角"，值得完整推敲：
  //
  //   key = `${workflowId}:${step}`
  //   例如 "WF-001:execute_refund"
  //
  // 为什么用 workflowId 而不是 approvalId？
  //   一个审批（APR-001）→ 一个工作流（WF-001）是
  //   createWorkflow 保证的（工作流启动幂等）。
  //   键跟工作流走：不同工作流的"同名步骤"天然不串账。
  //
  // 为什么带 step？
  //   同一个工作流里有多个副作用步骤
  //   （execute_refund 和 send_confirmation 各一个键）。
  //   不带 step 的话两个步骤会争同一个键，
  //   第二个步骤会"复用"第一个的结果——荒谬。
  //
  // 为什么稳定（不掺时间戳/随机数）？
  //   幂等键的全部意义就是"重试时能算出一模一样的键"。
  //   掺入任何每次变化的东西，重试就找不到旧记录了。
  //
  //   键的两个性质缺一不可：
  //     跨工作流唯一（workflowId 保证不串账）
  //     同工作流内稳定（纯函数、无随机源保证能重放）
  return `${workflowId}:${step}`;
}

export function loadEffects(paths: DataPaths): EffectRecord[] {
  // 读全部账本（含 Schema 校验——包括"type 与 step 配对"
  // 的判别联合检查，错配记录在这里就会被拒绝）。
  return readJsonArray(paths.effects, EffectRecordSchema, "Effects");
}

export function findEffectByKey(paths: DataPaths, key: string): EffectRecord | undefined {
  // 幂等查找：这个键下已有副作用了吗？
  // provider（steps.ts）做任何事之前的第一步就是它。
  return loadEffects(paths).find((effect) => effect.key === key);
}

/**
 * 追加一个新的 effect，强制一个幂等键恰好映射到一条记录。
 * `findEffectByKey` + `appendEffect` 是"先查后写"序列，
 * 不是原子操作，所以这是对抗 bug（或手改的账本）追加
 * 第二条同键记录的最后防线——它不是并发写竞争的修复，
 * 那要读 README 的 Production notes。
 */
export function appendEffect(paths: DataPaths, effect: EffectRecord): void {
  // 这段防御的姿态值得细品：
  //
  // 正常流程根本到不了那个 throw：
  //   provider 先 findEffectByKey → 有就复用 → 没有才 appendEffect
  //   所以"append 时发现键已存在"只可能意味着：
  //     a) 两个进程并发跑（check-then-write 竞态）
  //     b) 有人手改了账本
  //     c) provider 逻辑有 bug
  //  三种都是异常，正确的响应是【大声失败】，
  //  而不是"算了再记一条"——后者会让账本出现两行同键记录，
  //  幂等查找 find() 只返回第一行，另一行成了幽灵数据。
  //
  // 为什么说它不是并发修复？
  //   两个进程可能同时通过 findEffectByKey 的检查（都没查到），
  //   然后先后 append——第二个到这里时才会撞上防线。
  //   也就是说它能"事后发现"竞态，不能"事前阻止"竞态。
  //   真修复需要数据库唯一约束（append 天然原子）或锁。
  //   单进程演示里它够用；多进程生产里它是报警器，不是闸门。
  const effects = loadEffects(paths);
  if (effects.some((existing) => existing.key === effect.key)) {
    // some(谓词)：存在任一满足即 true——"已有一条同键记录"。
    throw new Error(
      `Refusing to append a second effect for idempotency key "${effect.key}". ` +
        "One key must map to exactly one effect record."
    );
  }
  effects.push(effect);
  // 账本只追加（append-only），和 11 章执行记录同款纪律。
  writeJsonArray(paths.effects, effects);
}

export function countEffectsByType(paths: DataPaths, type: EffectType): number {
  // 按类型计数（全部工作流合计）。
  // 主要给 index.ts 打印"refund effects: 1"——
  // 数字是验证"没有重复副作用"最直观的证据。
  return loadEffects(paths).filter((effect) => effect.type === type).length;
}

export function loadEffectsForWorkflow(paths: DataPaths, workflowId: string): EffectRecord[] {
  // 取某个工作流的全部副作用（不分类型）。
  // index.ts 用它打印"Side-effect ledger"区块。
  return loadEffects(paths).filter((effect) => effect.workflowId === workflowId);
}

export function countEffectsForWorkflowByType(
  paths: DataPaths,
  workflowId: string,
  type: EffectType
): number {
  // 组合查询：某工作流的某类副作用条数。
  // 最终断言"WF-001 refund effects: 1, confirmation effects: 1"
  // 就靠它——崩溃、恢复、重复运行之后，这两个数字必须还是 1。
  return loadEffectsForWorkflow(paths, workflowId).filter((effect) => effect.type === type).length;
}

/** 为一种 effect 类型生成下一个确定性结果 ID（例如 "REF-001"、"MSG-001"）。 */
export function nextEffectId(paths: DataPaths, prefix: string, type: EffectType): string {
  // 只从同类型的既有 effect 推导序号（REF 和 MSG 各自独立计数），
  // 与 11 章 nextResultId "按工具分开计数"同一思路。
  const ids = loadEffects(paths)
    .filter((effect) => effect.type === type)
    .map((effect) =>
      // 判别联合收窄后的安全访问：
      // type === "refund" 的分支里 result 必有 refundId，
      // 另一分支必有 confirmationId。不需要 ?.,不需要断言。
      effect.type === "refund" ? effect.result.refundId : effect.result.confirmationId
    );
  return nextSequentialId(prefix, ids);
}

// ============================================================
//  本文件小结：账本的三个性格
// ============================================================
//
// 1. 键的构造是设计，不是细节。
//    workflowId:step 同时满足"跨工作流唯一 + 同工作流稳定"。
//
// 2. append-only + 一键一记录。
//    追加是唯一写法；同键第二条直接拒绝（宁可崩，不幽灵）。
//
// 3. 诚实的局限声明。
//    check-then-write 不抗并发——防线是报警器不是闸门，
//    README 的 Production notes 写明了真解法
//    （数据库唯一约束 / 提供方原生幂等键）。
//
// 下一站：checkpointStore.ts，看"另一本账"。
// ============================================================
