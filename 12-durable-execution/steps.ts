// ============================================================
//  第十二章：步骤实现（steps.ts）
//  一步一个函数——纯校验、幂等退款、幂等通知
//
//  🏠 生活化比喻：剧场外合作的「收银台」（幂等提供方的化身）。
//  收银员每收一笔钱都先翻「发票登记簿」（幂等账本）：
//  这单开过票吗？开过 → 把上次的发票再递给你（复用）；
//  没开过 → 收款、开票、当场登记。刷卡失败重刷、网络重试
//  都不怕——同一张小票永远只收一次钱。门口的保安
//  （validate_approval）则只看批条真伪：纯检查，不动钱。
//
//  学习目标：
//  1. 分清两类步骤的恢复策略：
//     纯步骤（validate_approval）随便重跑，
//     副作用步骤必须过幂等闸
//  2. 理解"结构校验 vs 业务校验"的两层 Schema：
//     types.ts 证明"字段存在"，本文件的 Schema 判定"允许执行"
//  3. 掌握幂等提供方的标准形态：
//     查账本 → 有则复用 → 无则执行 → 记账本
//  4. 学会 fail closed：账本里键下躺着错误类型的记录时，
//     报错而不是"再记一条"
//
//  本文件在整个章节中的角色：
//  每个工作流步骤在这里是一个普通函数。
//  runner（workflowRunner.ts）负责排序、checkpoint 和崩溃注入；
//  本文件只知道"怎么干一个单元的活"。
//  一层管编舞，一层管动作——加新步骤时两边各自加一小块。
// ============================================================

import { z } from "zod";

import type { DataPaths } from "./config.js";
import { appendEffect, findEffectByKey, idempotencyKey, nextEffectId } from "./effectStore.js";
// 幂等四件套：查账本（findEffectByKey）、算键（idempotencyKey）、
// 记账本（appendEffect）、编结果 ID（nextEffectId）。
import type { ConfirmationEffectResult, RefundEffectResult, WorkflowInput } from "./types.js";
import { nowIso } from "./utils.js";

// 步骤实现。每个工作流步骤在这里是一个普通函数——
// runner（workflowRunner.ts）负责排序、checkpoint 和崩溃注入；
// 本文件只知道怎么做一个单元的工作。

// ─────────────────────────────────────────────────────────────────────────────
// validate_approval —— 纯函数，无副作用
// ─────────────────────────────────────────────────────────────────────────────

// 业务规则检查。它刻意比 WorkflowInputSchema（types.ts）严格——
// 那个只证明"这些字段以正确的原始类型存在"——
// 一个 pending 或 rejected 的审批完全能通过那个结构检查。
// 本 Schema 才真正决定执行是否允许进行，
// 而且它在步骤每次运行时都会跑，包括恢复之后。
const ValidatedRefundInputSchema = z
  .object({
    approvalId: z.string().regex(/^APR-\d+$/, 'approvalId must look like "APR-001"'),
    // ID 形状约束（11 章同款手法）。
    approvalStatus: z.literal("approved", {
      errorMap: () => ({ message: 'approvalStatus must be "approved"' }),
    }),
    // 业务核心之一：只放行 approved。
    // pending/rejected 在结构层（types.ts）能进门，
    // 在这里（业务层）被拒——两层 Schema 各司其职。
    toolName: z.literal("refundOrder", {
      errorMap: () => ({ message: 'toolName must be "refundOrder"' }),
    }),
    // 本演示只处理退款动作。真实系统这里会是判别联合
    // （每种动作一组规则），形态与 11 章 ActionProposal 一样。
    orderId: z.string().regex(/^ORD-\d+$/, 'orderId must look like "ORD-001"'),
    amount: z.number().positive("amount must be greater than 0"),
    // 金额必须为正。负数金额 = 变相扣款，直接拒绝。
    currency: z.literal("EUR", { errorMap: () => ({ message: 'currency must be "EUR"' }) }),
    // 只支持欧元（演示范围）。
    reason: z.string().min(1, "reason must be non-empty"),
    // 拒绝空理由：退款必须有可审计的业务依据。
  })
  .strict();
// 一张表总结两层 Schema 的分工（本章最重要的分层之一）：
//
// | 检查项            | types.ts 结构层      | 本 Schema 业务层        |
// |-------------------|----------------------|-------------------------|
// | approvalStatus    | 枚举三值都收         | 只收 "approved"         |
// | approvalId        | 任意字符串           | 必须 APR-数字           |
// | amount            | 任意数字             | 必须 > 0                |
// | currency          | 任意字符串           | 必须 "EUR"              |
// | 何时检查          | 创建时 + 每次读盘    | 每次步骤运行（含恢复）  |
//
// 为什么业务检查每次运行都要跑？
//   一张 pending 单可能躺着等了好几天才被批准、
//   又过了几天才开始执行。中间：
//   - 审批可能被撤销（11 章的拒绝是终态，但数据可能被手改）
//   - 规则可能收紧（新增币种限制）
//   "创建时合法"不等于"执行时合法"——恢复后的重跑
//   和首次运行走完全相同的验证，这本身就是纵深防御。

/**
 * 验证已批准的动作确实允许执行。纯的、无副作用——
 * 在它通过之前不可能发生退款或确认。
 * 任何违规都会抛出可读的消息；runner 会把那变成
 * 一个 `failed` 工作流，而不是可重试的崩溃。
 */
export function validateApproval(input: WorkflowInput): void {
  // 返回类型 void：这个步骤不产出数据，只产出"通过/抛错"。
  // 它是三步骤里唯一的纯步骤。
  const result = ValidatedRefundInputSchema.safeParse(input);
  if (!result.success) {
    const message = result.error.issues.map((issue) => issue.message).join("; ");
    // issues.map(...).join("; ")：把每个字段的错误消息
    // 拼成一行，如：
    //   Approval validation failed: amount must be greater than 0;
    //   currency must be "EUR"
    // 一次看到全部问题，而不是修一个再见下一个。
    throw new Error(`Approval validation failed: ${message}`);
    // 注意注释里"failed 而非可重试崩溃"的语义区分：
    //   业务失败（输入不合法）→ markFailed → 工作流终态 failed
    //     重跑也不会好（同样输入同样失败）
    //   崩溃（进程消失）       → 状态保持 running
    //     恢复后可继续（幂等保副作用）
    //   这两种"没跑完"的处理截然不同——见 workflowRunner.runStep。
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 副作用步骤 —— 在提供方边界上幂等
// ─────────────────────────────────────────────────────────────────────────────

export interface SideEffectOutcome<T> {
  // 两个副作用提供方共用的返回形状（泛型参数区分结果类型）。
  result: T;
  // 副作用的结果（新的或复用的）。
  reused: boolean;
  // true = 账本里已有同键记录，直接复用；
  // false = 真实执行了副作用。
  // runner 据此写 SIDE_EFFECT_REUSED 或 SIDE_EFFECT_EXECUTED 事件。
}

/**
 * Mock 退款提供方。幂等检查发生在这里——副作用边界本身——
 * 而不是在 runner 里用 `if (!completedSteps.includes(...))` 包一层。
 * 真实的支付提供方同样工作：它认出以前收到过的幂等键，
 * 返回原始结果，而不是再创建一笔扣款或退款。
 */
export function mockRefundProvider(
  paths: DataPaths,
  workflowId: string,
  input: WorkflowInput
): SideEffectOutcome<RefundEffectResult> {
  // "检查在提供方内部而不是 runner 外面"是本章的胜负手，值得三倍强调：
  //
  //   假设在 runner 外面拦：
  //     if (!completedSteps.includes("execute_refund"))
  //       callRefundProvider(...)
  //   这段判断依据的是 checkpoint——而崩溃恰恰污染的是 checkpoint！
  //   崩溃窗口里 completedSteps 没记这一步 → 判断说"没跑过"
  //   → 再调一次提供方 → 双倍退款。防线和漏洞在同一个数据源上。
  //
  //   提供方内部拦（本函数）：
  //     判断依据是提供方自己的账本（effects.json）——
  //     账本在副作用发生时就落盘了，不受崩溃窗口影响。
  //     重试带着同一个键来问，账本里有记录 → 复用。
  //
  //   结论：幂等检查必须守在"副作用真实发生的那一侧"，
  //   最好由下游系统自己提供（Stripe 的 Idempotency-Key 就是这个）。
  const step = "execute_refund" as const;
  // as const：把类型收窄成字面量 "execute_refund"——
  // 保证 idempotencyKey 的参数类型精确匹配 WorkflowStep。
  const key = idempotencyKey(workflowId, step);
  // "WF-001:execute_refund"——跨工作流唯一 + 同工作流稳定（见 effectStore）。
  //
  // 📤 走查（同一个函数的两条路径，带真实 ID）：
  //   首跑：账本里查无 "WF-001:execute_refund" → 汇款 49 欧
  //         → 账本记 { key, result: { refundId: "REF-001", ... } }
  //         → 返回 { result, reused: false }
  //   恢复重跑：账本命中同键 → 原样递回 REF-001
  //         → 返回 { result, reused: true }
  //         （钱没有第二次离开公司账户——这就是全部魔法）

  const existing = findEffectByKey(paths, key);
  // 第一件事永远是查账本，而不是干活。
  if (existing) {
    // Fail closed：一个已经属于错误 effect 类型的键
    // 是被污染的持久化状态，不是"在同键下再创建第二个 effect"的
    // 信号。在这里静默继续，恰恰是本模块反对的那种
    // "悄悄掩盖不一致状态"。
    if (existing.type !== "refund") {
      // 什么时候会出现"退款键下躺着确认记录"？
      //   正常代码不会产生（appendEffect 与 provider 对键↔类型
      //   的约定一致）。能出现就意味着：
      //   账本被手改 / 磁盘错乱 / 上游有严重 bug。
      //   正确姿势是停（fail closed），而不是猜着继续。
      throw new Error(
        `Idempotency key collision: "${key}" already belongs to a "${existing.type}" effect.`
      );
    }
    return { result: existing.result, reused: true };
    // 键存在且类型正确 → 复用结果。
    // 调用方（runner）随后只做 checkpoint，不再触发任何副作用。
    // 这两行就是"REF-001 不会被退成 REF-002"的全部秘密。
  }

  // 账本里没有 → 真实执行（mock 版）。
  const refundId = nextEffectId(paths, "REF", "refund");
  // 先编好确定性结果 ID（REF-001、REF-002...）。
  const result: RefundEffectResult = {
    refundId,
    orderId: input.orderId,
    amount: input.amount,
    currency: input.currency,
    status: "processed",
    mock: true,
    // 所有字段来自 input——注意金额是 11 章人工改成 49 的那笔。
  };

  appendEffect(paths, {
    // 关键顺序：结果先落账本，然后才 return。
    // 调用方拿到返回值之后的任何崩溃，账本里都已有记录；
    // 恢复重试会在这里命中 reused 分支。
    //
    // "先记账，后交货"在本地演示里是两次写盘之间的窗口；
    // 真实系统里对应"提供方处理中"窗口——所以真正的提供方
    // 幂等要在服务端原子完成（见 README Production notes）。
    key,
    workflowId,
    step,
    type: "refund",
    result,
    createdAt: nowIso(),
  });

  return { result, reused: false };
}

/** Mock 确认消息提供方。与退款提供方相同的幂等重放形态。 */
export function mockConfirmationProvider(
  paths: DataPaths,
  workflowId: string,
  input: WorkflowInput
): SideEffectOutcome<ConfirmationEffectResult> {
  // 与 mockRefundProvider 同构（连注释结构都几乎一样）——
  // 这不是偷懒：两个提供方刻意保持相同形态，
  // 让"幂等提供方"作为模式被看出来，而不是被两段
  // 不同的代码淹没。
  const step = "send_confirmation" as const;
  const key = idempotencyKey(workflowId, step);
  // "WF-001:send_confirmation"——注意与退款键不同
  // （step 不同），两个副作用互不干扰。

  const existing = findEffectByKey(paths, key);
  if (existing) {
    if (existing.type !== "confirmation") {
      // 同款 fail closed。
      throw new Error(
        `Idempotency key collision: "${key}" already belongs to a "${existing.type}" effect.`
      );
    }
    return { result: existing.result, reused: true };
  }

  const confirmationId = nextEffectId(paths, "MSG", "confirmation");
  // MSG-001：确认消息的编号序列，独立于 REF 计数。
  const result: ConfirmationEffectResult = {
    confirmationId,
    orderId: input.orderId,
    status: "sent",
    mock: true,
  };

  appendEffect(paths, {
    key,
    workflowId,
    step,
    type: "confirmation",
    result,
    createdAt: nowIso(),
  });

  return { result, reused: false };
}

// ============================================================
//  本文件小结：三种函数，三种纪律
// ============================================================
//
// | 函数                        | 副作用 | 恢复策略           |
// |-----------------------------|--------|--------------------|
// | validateApproval            | 无     | 直接重跑（免费）    |
// | mockRefundProvider          | 有     | 账本幂等闸         |
// | mockConfirmationProvider    | 有     | 账本幂等闸         |
//
// 纯步骤和副作用步骤需要不同的恢复策略——
// "重跑安全"只对纯函数免费；副作用的安全重跑
// 必须由副作用边界自己的幂等保证。
// 这个区分是 README"Why not just start again?"一节的代码化。
// ============================================================
