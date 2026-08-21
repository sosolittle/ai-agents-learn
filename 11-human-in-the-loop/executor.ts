// ============================================================
//  第十一章：执行器（executor.ts）
//  副作用发生前的最后一道安全门
//
//  🏠 生活化比喻：后屋那位「出纳」。他不听前台转述、不看便利贴，
//  只认三样亲手核实的东西：自己现查的《权限表》结论、
//  亲眼确认"已签字"（status === "approved"）的单据、
//  自己翻过的付款台账（有没有为这张单付过款）。
//  哪怕有人绕过前台直接把单子塞给他（测试里真这么干过），
//  他照样三查三对——查完才动手，动手必留痕。
//
//  学习目标：
//  1. 不信任上游已检查过的结论，在执行边界再次校验策略和状态
//     —— 纵深防御不是"检查很多次"的口号，而是每一层独立可守
//  2. 用 approvalId 查找已有执行，阻止重复副作用（本地幂等）
//  3. 区分"本地幂等恢复"和"分布式 exactly-once"
//  4. 理解写入顺序：先存执行事实，再发审计事件，最后由服务层推进状态
//
//  本文件在整个章节中的角色：
//  approvalService 是"流程编排者"，本文件是"扣扳机的人"。
//  即使有人绕过 service 直接调用 executeAction（测试里就这么试过），
//  这里的三道边界照样拦得住。安全不依赖"调用方守规矩"。
// ============================================================

import { appendAudit } from "./auditLog.js";
// 每次执行（或复用）都要留审计事件。
import {
  findExecutionByApprovalId,
  nextExecutionId,
  nextResultId,
  saveExecution,
} from "./approvalStore.js";
// 幂等查找 + ID 分配 + 事实落盘（见 approvalStore.ts 注释）。
import type { DataPaths } from "./config.js";
import { evaluatePolicy } from "./policy.js";
// 执行器自己重新查策略表——不接收调用方传来的"已判定结果"。
import { RESULT_ID_PREFIX, runTool } from "./tools.js";
// RESULT_ID_PREFIX 决定结果 ID 前缀（REF/CAN/...）；
// runTool 在工具调用前做最后一次参数复验。
import type { ApprovalRecord } from "./types.js";
import { nowIso } from "./utils.js";

export interface ExecutionOutcome {
  // 执行结果的标准返回形状。approveApproval 和 CLI 都消费它。
  executionId: string;
  // 本次执行（或被复用的那次执行）的 ID，形如 "EXE-001"。
  result: Record<string, unknown>;
  // 工具返回的业务结果（refundId、status 等）。
  // true 表示复用了这个审批已存在的一次执行，而不是
  // 再次运行了工具。
  recovered: boolean;
  // recovered 的两种 true 场景：
  //   1. 崩溃恢复：service 在 approve 时发现 execution 已存在
  //   2. 重复执行：本函数的边界 3 直接复用
  // CLI 用它给用户打印"工具没有被再次调用"的提示——
  // 让"没有发生的事"也可见，是幂等系统的可观测性要求。
}

/**
 * 执行一张审批单背后的工具，本地恰好一次，并记录它。
 *
 * 这是副作用前的最后一道门，它独立于审批服务守卫控制边界——
 * 直接调用无法绕过它：
 *
 *  1. 策略 deny 的工具永不执行；
 *  2. 需要审批的工具只能从 `approved` 记录执行——
 *     pending 或 rejected 记录在这里被拒，不只是在 service 里；
 *  3. 如果这个审批已存在执行，工具不会被再次调用；
 *     复用已有结果（按审批 ID 的本地幂等）。
 *
 * 这是本地幂等，不是分布式 exactly-once 保证。
 *
 * "本地幂等 vs exactly-once"到底差在哪（面试级问题）：
 *   本地幂等：
 *     在"这一个 JSON store、单进程依次调用"的世界里，
 *     同一个审批最多触发一次工具运行。
 *     判断依据（execution 记录）和执行动作在同一台机器上。
 *   exactly-once：
 *     在"多进程并发、网络会重试、消息会重复投递"的分布式世界里，
 *     副作用全局恰好发生一次。
 *     这需要下游系统（支付网关等）原生支持幂等键 + 分布式锁/事务。
 *   本模块的 execution 记录是前者的完整实现、后者的思想演示。
 */
export function executeAction(
  paths: DataPaths,
  approval: ApprovalRecord
): ExecutionOutcome {
  // 注意参数：调用方传进来的是"一张审批记录"，
  // 而不是"工具名 + 参数"。执行器要看记录的 status——
  // 这正是边界 2 的判据。
  const { toolName, arguments: args } = approval.proposedAction;
  // 解构 + 重命名一步完成：
  //   proposedAction.arguments 在解构时改名为 args，
  //   因为外层作用域想用简短的名字（arguments 在 JS 里是
  //   函数的保留局部变量名，必须重命名避开）。
  const policy = evaluatePolicy(toolName);
  // 不接收调用方传入的 policy 结果，而是根据 toolName 现场重新计算，
  // 避免调用方伪造或复用已经过期的授权结论。
  //
  // 这是纵深防御的"独立性"要求的具体化：
  //   如果 executeAction 接受 policy 参数，那么"伪造授权"只需要
  //   传 { decision: "auto_execute" } 进来。
  //   现场重算后，唯一的伪造途径是改 policy.ts 的表——
  //   那是代码，要过 code review 和 git 历史。
  //   "权限结论的来源必须比权限结论本身更难伪造。"

  // 边界 1：被禁止的工具永不执行。
  //
  // 📤 输入输出走查（一张伪造单据连闯三道门，测试 12/16/18 实录）：
  //   攻击 1（测试 12）：伪造 { toolName: "deleteProductionUsers",
  //             status: "pending" } 直接调 executeAction
  //     → 边界 1：查表得 deny → 抛 "Refusing to execute..."（当场按住）
  //   攻击 2（测试 16）：换造 { toolName: "refundOrder", status: "pending" }
  //     → 边界 1 过（退款不在黑名单）
  //     → 边界 2：require_approval 但 status ≠ approved → 按住
  //   攻击 3（测试 18）：{ ..., status: "approved" }（手工 upsert 伪造
  //             合法授权状态——测的是边界不能矫枉过正）
  //     → 三道门全过 → 工具真跑 → EXE/REF 落盘
  //   三次闯关对应三条边界"各自独立有效"——
  //   安全不靠调用方守规矩，靠每一层都自己把门。
  if (policy.decision === "deny") {
    throw new Error(
      `Refusing to execute "${toolName}": denied by policy. ${policy.reason}`
    );
    // 注意错误消息的措辞 "Refusing to..."（拒绝执行）：
    // 不是"无法执行"（能力问题），而是"拒绝执行"（权限问题）。
    // 精确的错误措辞能帮排查者快速定位是哪一层在拦。
  }

  // 边界 2：需要审批的工具必须来自 approved 记录。
  // 一张 pending 或 rejected 记录永远无法通过 executor 触达工具。
  if (policy.decision === "require_approval" && approval.status !== "approved") {
    // 复合条件的两个分支各司其职：
    //   policy.decision === "require_approval"
    //     → 这类工具需要人类点头
    //   approval.status !== "approved"
    //     → 但这张单还没到 approved（可能是 pending、rejected，
    //       甚至是没有进过审批流的伪造记录）
    // 两个条件缺一不可：auto_execute 的工具不走这道门（见 handleProposal
    // 里 policy 直接授权的路径），deny 的已经被边界 1 拦下。
    throw new Error(
      `Refusing to execute "${toolName}": human approval is required and the record is "${approval.status}", not "approved".`
    );
    // 测试 16/17（tests/runTests.ts）就是冲着这条来的：
    // 拿着 pending/rejected 记录直接调 executeAction，必须被拒。
  }

  // 边界 3（本地幂等）：复用这个审批已有的执行。
  // 执行记录是"工具已经运行过"的持久证据。
  const existing = findExecutionByApprovalId(paths, approval.id);
  if (existing) {
    // 走到这里的三种典型情形：
    //   1. service 正常路径重复调用（重复点击 approve）
    //   2. 崩溃恢复：execution 已落盘、状态没翻成 executed
    //   3. 任何绕过 service 的直接调用恰好带了已执行过的审批
    // 三种情形的回答一致：不再跑工具，返回已有事实。
    appendAudit(paths, {
      event: "EXISTING_EXECUTION_RECOVERED",
      approvalId: approval.id,
      toolName,
      metadata: { executionId: existing.id },
      // 复用也要留痕：审计日志要能回答"第二次 approve 时发生了什么"——
      // 答案是"什么都没发生，复用了 EXE-001"。
    });
    return { executionId: existing.id, result: existing.result, recovered: true };
    // recovered: true 告诉调用方"这是复用不是新执行"，
    // CLI 据此打印不同的提示文案。
  }

  const executionId = nextExecutionId(paths);
  // 分配执行 ID："EXE-001"...
  const resultId = nextResultId(paths, RESULT_ID_PREFIX[toolName], toolName);
  // 分配业务结果 ID：退款是 "REF-001"、取消是 "CAN-001"...
  // executionId 标识"这次工具运行"；resultId 标识业务结果（如退款单）。
  // 两者分开可以让工作流记录与下游业务记录各自拥有稳定标识。
  //
  // 为什么要两个 ID？想象只有一个 ID：
  //   "EXE-001 退款了 REF...多多少？"——工作流视角和业务视角
  //   对"一次执行"的定义可能不同（一次执行可能产生多个业务对象）。
  //   分开后：EXE-001 → 审计/恢复用；REF-001 → 对客户/对账用。

  // runTool 会在调用前用工具 Schema 再次校验参数。
  const result = runTool(toolName, args, resultId);
  // runTool 内部（见 tools.ts）：
  //   1. 用 ActionProposalSchema.parse 复验 toolName + args
  //   2. switch 分发到对应 mock 工具
  //   3. 返回带 resultId 的类型化结果
  // 参数复验放在最后一步的意义：
  //   记录在磁盘上躺了三天、被人手改过、格式漂了——
  //   到这里都会被拦下，而不是带着畸形参数碰业务数据。

  saveExecution(paths, {
    id: executionId,
    approvalId: approval.id,
    toolName,
    arguments: args,
    result,
    executedAt: nowIso(),
    // 参数快照 + 结果 + 时间戳，一条完整的事实记录。
    // 注意先存事实、再发事件、状态推进交给 service：
    //   崩溃在 saveExecution 之前 → 什么都没发生，可安全重试
    //   崩溃在 saveExecution 之后 → 事实在手，恢复时复用它
    // 无论哪一刻断电，系统都没有"钱扣了但没记录"的窗口（本地范围内）。
  });
  // 先持久化执行结果，再写审计事件。之后审批服务会把 approval 状态推进
  // 到 executed；若进程恰好在中间崩溃，重试时会通过 execution 记录恢复。
  //
  // 这几行的顺序是本章和第 12 章共享的核心思想——
  // "先记事实，再改状态"：
  //   事实（execution）是恢复的锚点，状态（approval.status）只是摘要。
  //   摘要可以重算，事实不能凭空捏造。

  appendAudit(paths, {
    event: "ACTION_EXECUTED",
    approvalId: approval.id,
    toolName,
    metadata: { executionId, result },
    // 把完整 result 也放进 metadata：审计日志要能独立回答
    // "REF-001 到底退了多少钱"，不需要再去翻 executions.json。
  });

  return { executionId, result, recovered: false };
  // recovered: false → 这是一次全新的执行。
}

// ============================================================
//  本文件小结：三道边界一张表
// ============================================================
//
// | 边界 | 检查什么                | 拦住谁                     |
// |------|-------------------------|---------------------------|
// | 1    | policy === deny         | 一切路径下的禁用工具       |
// | 2    | 状态必须是 approved     | pending/rejected/伪造记录 |
// | 3    | 已有执行则复用          | 重复执行/崩溃后的重试      |
//
// 再加上 tools.ts 里的参数复验和 deleteProductionUsers 的"无实现"，
// 一共五层防线。任何一层被绕过（bug、绕路调用、手改数据），
// 其余层依然有效——这就是纵深防御（defense in depth）。
//
// 同时记住它的边界：本地幂等 ≠ 分布式 exactly-once。
// 多进程并发写同一个 JSON 文件时这套检查有竞态窗口，
// 生产系统要靠数据库唯一约束或下游幂等键补齐。
// ============================================================
