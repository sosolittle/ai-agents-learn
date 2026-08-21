// ============================================================
//  第十一章：审批服务（approvalService.ts）
//  人工审批生命周期的编排中心
//
//  🏠 生活化比喻：审批处的「调度台」。
//  一张单据从进窗口到出结果要盖好几个章：查权限表、登记、
//  主管签字、出纳付款、台账留痕。调度台自己不盖任何一个章——
//  它只决定"下一步把单子递给谁"：权限表在 policy.ts、
//  文件柜在 approvalStore.ts、出纳在 executor.ts、
//  台账在 auditLog.ts。但单据的一生——
//  propose → gate → pending → edit → approve/reject → execute → audit——
//  每一步的先后顺序由这里说了算，而顺序本身就是安全设计
//  （先落盘授权再付款、先记账再改状态，顺序错了崩溃窗口就变大）。
//
//  学习目标：
//  1. 看懂提案如何经过策略后进入三种结果：
//     自动执行（auto_executed）/ 待审批（pending）/ 拒绝（denied）
//  2. 掌握 pending → approved → executed / rejected 的状态迁移，
//     以及"先授权落盘、后执行、成功才标 executed"的顺序
//  3. 理解人工编辑只允许修改工具参数，并且必须整体重新校验
//  4. 通过执行记录完成重复执行拦截和崩溃恢复
//  5. 体会"审批时重新校验"：创建时合法 ≠ 执行时合法
//
//  本文件在整个章节中的角色：
//  它是流程的"总调度"：调用策略门、写审批单、响应 CLI 命令
//  （编辑/批准/拒绝）、调用 executor、追加审计事件。
//  但它不越权：策略在 policy.ts、执行在 executor.ts、
//  存储在 approvalStore.ts、审计在 auditLog.ts——
//  每个职责一个模块，本文件只负责"按什么顺序调用它们"。
//
//  注意：
//  编排层不是安全边界的唯一守门人，executor 还会再次检查。
//  即使本文件的逻辑出 bug，executor 的三道边界依然独立生效。
// ============================================================

import { appendAudit } from "./auditLog.js";
// 每个生命周期节点都要留审计事件。
import {
  findApproval,
  findExecutionByApprovalId,
  loadApprovals,
  nextApprovalId,
  upsertApproval,
} from "./approvalStore.js";
// 审批单和执行记录的持久化接口。
import type { DataPaths } from "./config.js";
import { executeAction, type ExecutionOutcome } from "./executor.js";
// 真正扣扳机的地方（带自己的三道边界）。
import { evaluatePolicy } from "./policy.js";
// 确定性策略门。
import {
  ActionProposalSchema,
  type ActionProposal,
  type ApprovalRecord,
  type PolicyResult,
  type ProposedAction,
} from "./types.js";
// 数据契约：提案（判别联合）、审批记录、策略结果。
import { nowIso, writeJsonArray } from "./utils.js";

// 审批服务是编排层。它把模型提案、策略门、持久化和执行
// 串在一起——但这些职责各自住在自己的模块里。
// 本文件拥有生命周期：
// propose → gate → (pending) → edit → approve/reject → execute-once → audit。

// 人工编辑器绝不允许通过 edit 命令修改的记录字段。
// 只有工具参数可编辑；身份、状态、时间戳、选定的工具
// 和执行链接都不可触碰。
const PROTECTED_EDIT_FIELDS = new Set([
  // Set：成员唯一的集合，has() 查询是 O(1)。
  // 用 Set 而不是数组：编辑请求的每个 key 都要查一次，
  // 数组 includes 是 O(n)，Set has 是 O(1)——
  // 更重要的是语义：这是"集合"，不是"列表"。
  "id",
  // 审批单身份。改了它，历史审计事件就和记录对不上了。
  "status",
  // 状态是状态机的领地。允许编辑 status 意味着
  // 一条命令就能把 pending 改成 executed——
  // 整个审批体系瞬间形同虚设。这是本表里最致命的字段。
  "createdAt",
  "updatedAt",
  // 时间戳是审计事实，不接受人工修饰。
  "toolName",
  // 编辑参数 ≠ 换工具。"退款单改成取消订阅"不是编辑，
  // 是新的业务意图，应该走新的提案+审批。
  "executionId",
  // 执行链接指向已发生的事实，事实不可改写。
  "decisionReason",
  // 拒绝理由是历史决定的一部分。
  "proposedAction",
  // 整个动作对象（含嵌套的 arguments）不可整体替换——
  // 只能通过 CLI 的顶层参数名逐字段编辑（见 editApproval）。
  "originalRequest",
  // 用户原话是审计上下文，不可修饰。
]);
// 读一遍这张表会发现一个模式：**凡是"事实"或"身份"的字段都保护，
// 只有"提案内容"（参数值）开放编辑。** 编辑权限的边界
// 就是"人可以改变主意，但不能改变历史"。

// 重新校验前必须从 CLI 字符串强转为数字的参数字段。
// 其他字段保持字符串。
const NUMERIC_ARG_FIELDS = new Set(["amount"]);
// CLI 的世界一切都是字符串：--amount=49 传进来是 "49"。
// Zod 的 z.number() 不会接受字符串（严格类型是好性质），
// 所以在合并编辑前把已知数值字段做一次显式转换。
// 白名单式（只转 amount）而不是"智能转换所有数字样字符串"：
// 猜测式转换会让 --orderId=123 偷偷变成数字 123，埋下类型惊喜。

export type ProposalOutcome =
  | {
      kind: "auto_executed";
      record: ApprovalRecord;
      policy: PolicyResult;
      execution: ExecutionOutcome;
    }
  | {
      kind: "pending";
      record: ApprovalRecord;
      policy: PolicyResult;
      duplicateOf?: string;
    }
  | { kind: "denied"; policy: PolicyResult; toolName: ActionProposal["toolName"] };
// ProposalOutcome 是判别联合：
// - auto_executed 一定带 execution
// - pending 一定带 record，并可能指向 duplicateOf
// - denied 没有 approval record，因为禁止动作不会进入人工队列
//
// TS 语法小讲：denied 分支里的 toolName: ActionProposal["toolName"]
// 是「索引访问类型」（indexed access type）——直接"取"联合类型
// ActionProposal 里 toolName 字段的类型（即 ToolName）。
// 好处：不 import ToolName 也能引用它，而且上游改枚举时
// 这里自动跟着变（approvalStore.nextResultId 用过同一招）。
//
// 这是"结果类型"（result type）模式在 TS 里的标准形态：
//   一个 kind 字段判别 + 每种结果只携带自己需要的数据。
//   对比"返回一个巨型对象 + 一堆可空字段"：
//     { record?, execution?, policy, denied?, toolName? }
//   调用方永远不知道哪些字段有值，TS 也帮不上忙。
//   判别联合让 index.ts 里的 if (outcome.kind === "denied")
//   自动收窄出正确的字段组合——非法组合（denied 带 execution）
//   在类型上就写不出来。

function toProposedAction(proposal: ActionProposal): ProposedAction {
  // ApprovalRecord 只保存后续流程需要的动作信息，不把模型输出对象本身
  // 当成权限凭据；权限始终来自 policy 或人工状态迁移。
  //
  // 这一步是"判别联合 → 开放记录"的类型转换
  // （ActionProposal 四种具体形状 → ProposedAction 的宽形状）：
  //   存储时放宽（一张单要能装四种工具的参数），
  //   使用时收紧（编辑后、执行前都用 ActionProposalSchema 复验）。
  //   转换是有意为之且有校验兜底的，不是偷懒。
  return {
    toolName: proposal.toolName,
    arguments: proposal.arguments,
    reason: proposal.reason,
  };
}

function argumentsEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  // 本例参数来自严格 Schema，字段顺序稳定，因此 JSON 字符串比较足够直观。
  // 生产环境可改用 canonical JSON 或业务幂等键，不能依赖任意对象的键顺序。
  //
  // 为什么本章敢用 JSON.stringify 比较？
  //   1. 参数都经过 .strict() Schema 校验：字段集合固定、无额外字段
  //   2. 参数由代码从记录里原样读出，键顺序由 JSON 文件保证不变
  //   哪来的顺序问题？JSON.stringify 按"对象键的插入顺序"输出。
  //   {"a":1,"b":2} 和 {"b":2,"a":1} 语义相同但字符串不同。
  //   如果参数来自外部系统（键顺序不可控），这个比较会漏判相等，
  //   生产中应先做键排序（canonical JSON）再比较。
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * 接收一个已验证的模型提案，把它路由经过策略门。
 *
 * - `deny`  → 审计并拒绝。不创建记录；工具永不可达。
 * - `auto_execute` → 立即执行并记录为 executed。
 * - `require_approval` → 为人类持久化一张 pending 审批单。
 *   如果同一请求已存在一张相同的 pending 单，就复用它而不是
 *   再造一张（这样重跑演示不会堆积副本）。
 *
 * 尽管提案已经有了类型，这里仍然重新校验——
 * 这样本函数用磁盘加载的数据或测试里构造的数据调用也是安全的。
 */
export function handleProposal(
  paths: DataPaths,
  originalRequest: string,
  rawProposal: unknown
): ProposalOutcome {
  // 注意第三个参数的类型是 unknown——不是 ActionProposal。
  // 这是刻意的接口设计（和 executor 现场重算 policy 同一思路）：
  // 边界函数不信任"调用方声称的类型"。

  // 第 1 道运行时边界：即使调用方在 TypeScript 中声明了正确类型，
  // 这里仍把传入值视为 unknown 并重新校验，防止磁盘/网络/测试伪造数据。
  const proposal = ActionProposalSchema.parse(rawProposal);
  // parse 失败直接抛 ZodError，错误里带完整的字段路径——
  // 对"入口函数"来说，坏数据立刻崩溃是正确行为。
  const proposedAction = toProposedAction(proposal);
  // 转成存储用的宽形状（见上面 toProposedAction 的说明）。

  // 先记录模型提出了什么，再记录系统如何判定，审计日志才能还原完整因果链。
  //
  // 注意审计顺序的设计：事件按发生顺序追加，
  // 重放日志时看到 ACTION_PROPOSED → POLICY_EVALUATED → ...
  // 正好是决策链的因果顺序。谁先谁后在审计里是证据，不是细节。
  appendAudit(paths, {
    event: "ACTION_PROPOSED",
    toolName: proposal.toolName,
    metadata: { originalRequest, arguments: proposal.arguments },
    // metadata 里带上原始请求和参数：
    // 提案事件要能独立回答"模型基于什么请求、提出了什么参数"。
  });

  const policy = evaluatePolicy(proposal.toolName);
  appendAudit(paths, {
    event: "POLICY_EVALUATED",
    toolName: proposal.toolName,
    metadata: { decision: policy.decision, reason: policy.reason },
  });

  // ── 分支 1/3：deny ────────────────────────────────────────────────
  if (policy.decision === "deny") {
    // 禁止：永不创建可执行记录。写一条显式的拒绝事件，
    // 让这次拒绝在审计时间线里可见。
    appendAudit(paths, {
      event: "ACTION_DENIED",
      toolName: proposal.toolName,
      metadata: { originalRequest, reason: policy.reason },
    });
    return { kind: "denied", policy, toolName: proposal.toolName };
    // denied 分支只有三个字段，没有 record——
    // "没有审批单"本身就是结果的一部分。
  }

  // ── 分支 2/3：auto_execute ────────────────────────────────────────
  if (policy.decision === "auto_execute") {
    // 策略本身授权了这个动作，所以它直接进入 `approved`——
    // 但在工具真正成功之前不会是 `executed`。如果执行抛错，
    // 记录会诚实地停留在 `approved`，绝不谎称 `executed`。
    const now = nowIso();
    const approved: ApprovalRecord = {
      id: nextApprovalId(paths),
      // 注意：auto_execute 也会占用一个 APR 编号。
      // 所有路径共享同一套编号/审计/存储，可观测性保持一致。
      originalRequest,
      proposedAction,
      status: "approved",
      // 授权者是 policy，所以状态一创建就是 approved。
      createdAt: now,
      updatedAt: now,
    };
    upsertApproval(paths, approved);
    // auto_execute 不是"绕过审批状态机"，而是由 policy 充当授权者。
    // 因此仍先落盘 approved，再执行，失败时状态不会谎称 executed。
    //
    // "policy 授权"和"human 授权"走同一条状态机：
    //   approved → executed
    // 区别只在授权事件的 metadata（authorizedBy: "policy" vs "human"）。
    // 一条状态机、两种授权来源，审计上分得清、流程上不分裂。
    appendAudit(paths, {
      event: "ACTION_APPROVED",
      approvalId: approved.id,
      toolName: approved.proposedAction.toolName,
      metadata: { authorizedBy: "policy" },
      // 授权来源写进审计：出问题时能立刻分辨
      // "这是人工批的还是策略放的"。
    });

    const execution = executeAction(paths, approved);
    // executor 的边界 2 检查"require_approval 必须 approved"——
    // auto_execute 的工具不受那条约束，正常放行。
    const executed: ApprovalRecord = {
      ...approved,
      // 展开旧记录再覆盖部分字段——"基于 approved 演进"的惯用写法。
      status: "executed",
      executionId: execution.executionId,
      updatedAt: nowIso(),
      // updatedAt 用新的时间戳：执行本身耗时，两个时间点应有区别。
    };
    upsertApproval(paths, executed);
    return { kind: "auto_executed", record: executed, policy, execution };
    // 返回带 execution 的完整结果，index.ts 直接打印工具结果。
  }

  // ── 分支 3/3：require_approval ────────────────────────────────────
  // require_approval：如果已存在一张相同的 pending 单，就复用它。
  // 只复用 pending：已经 rejected/executed 的历史记录代表一次完成的决策，
  // 新请求不应偷偷复活旧记录，而应该创建新的审批上下文。
  //
  // 为什么要有重复检测？
  //   npm start 跑两次 = 两次模型提案 = 两张 pending 单 =
  //   审批人面对两张一模一样的单，批两次 = 退两次款。
  //   在"创建审批单"这一步就折叠重复，是最省心的幂等点。
  // 为什么只认 pending？
  //   rejected/executed 的单是"已关闭的历史"：
  //   复用 rejected 的单 = 偷偷给被拒绝的请求第二次机会；
  //   复用 executed 的单 = 把新请求挂在旧退款上。
  //   历史就是历史，新请求开新单。
  //
  // 📤 走查（重复检测为什么必要）：npm start 手滑跑了两次——
  //   第一次：创建 APR-001 [pending]，进程退出
  //   第二次：同样的原话、同样的工具、同样的参数
  //           → find 命中 APR-001 → 返回 duplicateOf: "APR-001"
  //           → 审批人列表里永远只有一张单，不可能批出两笔退款
  //   没有这段逻辑：两张一模一样的单并排躺在柜子里，
  //   忙碌的主管很可能"都批了"——钱就退了两次。
  const duplicate = loadApprovals(paths).find(
    (existing) =>
      existing.status === "pending" &&
      // 三重相同才叫"重复"：
      existing.originalRequest === originalRequest &&
      // ① 用户原话相同（不是类似的另一句话）
      existing.proposedAction.toolName === proposedAction.toolName &&
      // ② 工具相同
      argumentsEqual(existing.proposedAction.arguments, proposedAction.arguments)
      // ③ 参数完全相同
    // 三个条件都指向同一个语义："一模一样的申请，已经有一张在等了"。
    // 少任何一个都可能把"相似但不同"的请求错误折叠——
    // 比如同一订单第二次损坏退款，理由不同就不该合并。
  );
  if (duplicate) {
    // 重复 pending 不再写 APPROVAL_REQUESTED，避免审计日志表现得像创建了
    // 一张新审批单；调用方通过 duplicateOf 明确知道复用了哪一张。
    return { kind: "pending", record: duplicate, policy, duplicateOf: duplicate.id };
    // 注意这里没有 appendAudit——审计日志只记录"真正发生的事"，
    // 而"没有创建新单"不是 approvalService 层面的事件。
    // duplicateOf 让调用方（index.ts）去解释这个情况。
  }

  const now = nowIso();
  const record: ApprovalRecord = {
    id: nextApprovalId(paths),
    originalRequest,
    proposedAction,
    status: "pending",
    // 流程在这里"暂停"：不是异步等待，而是持久化后由本函数返回。
    // 当前进程退出后，CLI 在另一个进程里接着推这张单。
    createdAt: now,
    updatedAt: now,
  };
  upsertApproval(paths, record);
  // pending 单落盘——这就是"等待人类"的持久化形式。

  appendAudit(paths, {
    event: "APPROVAL_REQUESTED",
    approvalId: record.id,
    toolName: record.proposedAction.toolName,
  });

  return { kind: "pending", record, policy };
}

export interface EditResult {
  record: ApprovalRecord;
  // 编辑后的完整记录。
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  // 编辑前后的参数快照。CLI 用它打印对比，
  // 审计日志也用同一份数据（见 editApproval 里 ACTION_EDITED）。
}

/**
 * 编辑一张 pending 审批单的参数。
 *
 * 编辑是一个人类业务决定（例如判定 €49 的部分退款才合理），
 * 不是模型纠错。只有工具参数可以改；受保护的记录字段会被拒绝。
 * 合并后的参数会用工具 Schema 重新校验，所以非法编辑
 * （负数金额、未知字段）会在保存前失败。记录保持 pending。
 */
export function editApproval(
  paths: DataPaths,
  id: string,
  edits: Record<string, string>
): EditResult {
  // edits 的形状：{ amount: "49", reason: "..." }
  // 注意值全是字符串——CLI 参数天然如此，
  // 数值转换由下面的 NUMERIC_ARG_FIELDS 机制处理。

  // requirePending 同时完成"记录存在"和"当前仍可编辑"两个前置条件检查。
  const record = requirePending(paths, id, "edit");
  // 只有 pending 可编辑。approved 之后参数就"冻结"了——
  // 想改？先考虑清楚再批准，或者拒绝后重新提案。
  // 这避免了"批准的是 49，执行的是 79"这类灾难性错位：
  // 批准那一刻的参数 == 执行那一刻的参数，由状态机保证。

  for (const key of Object.keys(edits)) {
    if (PROTECTED_EDIT_FIELDS.has(key)) {
      // 逐个检查编辑字段是否踩了保护名单。
      // 注意检查发生在一切合并/落盘之前——先拒绝，后动手。
      throw new Error(
        `Cannot edit protected field "${key}". Only tool arguments may be edited.`
      );
      // --status=executed 这种"一句话提权"的命令在这里死掉。
      // 测试 11 专门验证这条防线。
    }
  }

  const before = { ...record.proposedAction.arguments };
  // before/after 会进入审计日志，使审核人对金额、理由等修改可追溯。
  // 浅拷贝快照：后面合并会创建新对象，但显式拷贝让
  // "before 是编辑前的快照"这个意图一目了然。

  // 把编辑合并到当前参数上，转换数值字段。
  const mergedArgs: Record<string, unknown> = { ...before };
  for (const [key, value] of Object.entries(edits)) {
    // Object.entries 返回 [键, 值] 二元组数组，
    // 解构到 key/value 后逐项处理。
    mergedArgs[key] = NUMERIC_ARG_FIELDS.has(key) ? coerceNumber(key, value) : value;
    // amount → coerceNumber（字符串转数字，转不动就抛错）
    // 其他   → 原样字符串
  }
  // 合并语义是"覆盖同名键"：
  //   before = { orderId, amount: 79, ... }
  //   edits  = { amount: "49" }
  //   merged = { orderId, amount: 49, ... }
  // 未在编辑里出现的字段保持原值。

  // 重新校验整个动作。坏编辑（负数金额、错误币种、
  // 未知字段）在这里抛错，什么都不会被持久化。
  const revalidated = ActionProposalSchema.parse({
    toolName: record.proposedAction.toolName,
    arguments: mergedArgs,
    reason: record.proposedAction.reason,
    // reason 取记录里原有的（编辑工具参数不影响提案理由）。
  });
  // 先完成全部校验，再 upsert。任何异常都会在写盘前抛出，
  // 所以失败的编辑不会留下半更新记录。
  //
  // "要么全部生效，要么全不生效"——没有中间态落盘。
  // JSON 文件存储没有事务，靠"先校验后写入"的顺序保证这一点
  // （前提：单进程内没有并发写）。
  //
  // 这次校验拦得住什么？举例：
  //   --amount=-10   → z.number().positive() 拒绝
  //   --currency=USD → z.literal("EUR") 拒绝
  //   --bonus=1      → arguments 的 .strict() 拒绝未知字段
  // 编辑不是"修补"，是把新参数当成全新提案完整重审。

  const updated: ApprovalRecord = {
    ...record,
    proposedAction: toProposedAction(revalidated),
    // 存储重新校验后的（可能被 Zod 规范化过的）动作。
    updatedAt: nowIso(),
    // createdAt 不变——这是同一张单的演进，不是新单。
  };
  upsertApproval(paths, updated);

  appendAudit(paths, {
    event: "ACTION_EDITED",
    approvalId: updated.id,
    toolName: updated.proposedAction.toolName,
    metadata: { before, after: updated.proposedAction.arguments },
    // before/after 进审计：审核链上要能看见"模型提的是 79，
    // 人改成了 49"——人的判断和模型的判断各自可辨。
  });

  return { record: updated, before, after: updated.proposedAction.arguments };
}

export interface ApproveResult {
  record: ApprovalRecord;
  execution?: ExecutionOutcome;
  // 执行信息。blocked 为 true 时没有执行发生，所以是可选的。
  blocked: boolean;
  // true = 这次 approve 被判定为重复，工具没有被再次调用。
  // 三种返回形态：
  //   { blocked: true }                          → 重复，已拦截
  //   { blocked: false, execution: {recovered} } → 崩溃恢复，复用
  //   { blocked: false, execution: {新执行} }     → 正常执行
}

/**
 * 批准一张 pending 单：先授予权限，然后把它的工具执行恰好一次。
 *
 * 状态迁移：`pending → approved → executed`。权限在工具运行
 * 【之前】授予（并持久化为 `approved`），记录只有在工具成功之后
 * 才变成 `executed`——所以状态永远真实。
 *
 * 幂等 / 恢复：
 *  - 已 `executed` 的记录拦截重复（DUPLICATE_EXECUTION_BLOCKED）；
 *  - 如果这个审批已存在一次执行（例如保存执行之后、翻转状态
 *    之前发生的崩溃），已有的结果会被对账并复用，
 *    而不是再次运行工具。
 *
 * 在授予批准之前，动作会被重新校验、策略会被重新评估：
 * 工具必须仍然被精确分类为 `require_approval`，
 * 这样漂移成 `deny` 或 `auto_execute` 的策略
 * 就无法借这张存储的工作流执行。
 */
export function approveApproval(paths: DataPaths, id: string): ApproveResult {
  const record = requireExisting(paths, id);

  // ── 幂等守卫 1：已 executed → 拦截重复，不重跑。─────────────────
  // 这是最常见的重复点击/重复命令路径：审批单已经明确指向 executionId。
  if (record.status === "executed") {
    appendAudit(paths, {
      event: "DUPLICATE_EXECUTION_BLOCKED",
      approvalId: record.id,
      toolName: record.proposedAction.toolName,
      metadata: { executionId: record.executionId },
    });
    return { record, blocked: true };
    // 原样返回记录，blocked: true。
    // CLI 看到 blocked 打印"重复已拦截"；测试 7 断言执行数不变。
  }

  // ── 幂等守卫 2：崩溃恢复。───────────────────────────────────────
  // 已存在一次执行，但记录从未推进到 `executed`。
  // 对账记录并复用已有结果。
  // 这处理一个很窄但很重要的崩溃窗口：
  // saveExecution 成功 → 进程崩溃 → approval 尚未更新为 executed。
  //
  // 📤 输入输出走查（崩溃窗口的对账，带真实 ID）：
  //   第一次 approve：APR-001 → approved 落盘 ✓ → 工具跑完
  //     EXE-001 落盘 ✓ → 就在翻状态成 executed 之前 💥 断电
  //   重新开机，第二次 approve 同一张单：
  //     读单 → 状态还是 approved；查执行 → 找到 EXE-001
  //     → 不再调工具，直接把状态补成 executed
  //     → 审计多一条 EXISTING_EXECUTION_RECOVERED
  //   退款自始至终只有 REF-001 这一笔——
  //   用事实（execution）修复状态（approval），而不是重演事实。
  //
  // 时间轴：
  //   [1] approved 落盘        ← 人工权限已持久化
  //   [2] 工具运行成功
  //   [3] execution 落盘       ← 事实已持久化
  //   [4] approval → executed  ← 摘要更新
  //   崩溃在 [3] 与 [4] 之间：事实在、摘要旧。
  //   恢复策略：用事实修摘要（下面这段代码），不重跑工具。
  const priorExecution = findExecutionByApprovalId(paths, record.id);
  if (priorExecution) {
    const reconciled: ApprovalRecord = {
      ...record,
      status: "executed",
      executionId: priorExecution.id,
      updatedAt: nowIso(),
    };
    upsertApproval(paths, reconciled);
    appendAudit(paths, {
      event: "EXISTING_EXECUTION_RECOVERED",
      approvalId: record.id,
      toolName: record.proposedAction.toolName,
      metadata: { executionId: priorExecution.id },
    });
    return {
      record: reconciled,
      execution: {
        executionId: priorExecution.id,
        result: priorExecution.result,
        recovered: true,
        // recovered: true → CLI 打印"复用了已有执行"，
        // 测试 20 断言 executionId 与第一次相同、总执行数仍是 1。
      },
      blocked: false,
    };
  }

  if (record.status !== "pending") {
    // rejected 不能被原地改回 approved；若业务需要重新申请，应生成新记录，
    // 这样旧的拒绝决定仍完整保留在历史中。
    //
    // 走到这里的只可能是 rejected（executed 上面拦了，
    // approved 呢？——正常流程不会拿 approved 单再 approve，
    // 万一发生，也说明状态被外力动过，同样拒绝最安全）。
    // "拒绝是终态"是审批系统的通例：翻案 = 新案。
    throw new Error(
      `Approval ${id} is "${record.status}", not "pending". It cannot be approved.`
    );
  }

  // ── 授予批准前的双重复核。────────────────────────────────────────
  // 重新校验动作，并在批准时重新评估策略。
  ActionProposalSchema.parse({
    toolName: record.proposedAction.toolName,
    arguments: record.proposedAction.arguments,
    reason: record.proposedAction.reason,
  });
  // 审批时再次校验是必要的：pending 记录可能等待了很久，也可能被外部系统
  // 修改过。不能因为"创建时合法"就假设"执行时仍合法"。
  //
  // "创建时"和"使用时"之间隔着真实世界的时间：
  //   - Schema 可能升级了（新规则更严）
  //   - 数据可能被手改过
  //   - 记录可能由旧版本代码写入
  // 每次跨越时间使用数据，都值得重新校验一次。

  // 存储的工作流必须仍然精确匹配当前策略。如果工具不再是
  // `require_approval`，人工审批路径就是无效的。
  const policy = evaluatePolicy(record.proposedAction.toolName);
  if (policy.decision !== "require_approval") {
    // 场景：一张旧 pending 单躺着，期间策略表被改了——
    //   refundOrder 改成 deny   → 不该再能人工放行
    //   refundOrder 改成 auto   → 不需要人工放行，走错门了
    // 两种漂移都拦下，要求走新提案。
    // 测试 22 验证这条（stale 记录 + auto_execute 工具 → 抛错）。
    throw new Error(
      `Approval ${id} cannot continue because "${record.proposedAction.toolName}" is no longer classified as require_approval (now "${policy.decision}").`
    );
  }

  // ── 授予权限：pending → approved。───────────────────────────────
  const approved: ApprovalRecord = {
    ...record,
    status: "approved",
    updatedAt: nowIso(),
  };
  upsertApproval(paths, approved);
  // 先持久化授权，再调用工具。若工具失败，记录停留在 approved，
  // 准确表达"已获准但尚未完成"，便于后续重试或人工处置。
  //
  // 为什么"先落盘授权再执行"而不是反过来？
  //   想象顺序相反（先执行、成功后再写 approved）：
  //     执行成功 → 崩溃 → 授权没落盘
  //     → 系统里出现一笔"没有授权记录的执行"——审计灾难。
  //   先授权后执行，任何崩溃点的最坏情况都是
  //   "有授权、没执行"（可安全重试），而不是"有执行、没授权"。
  appendAudit(paths, {
    event: "ACTION_APPROVED",
    approvalId: approved.id,
    toolName: approved.proposedAction.toolName,
    metadata: { authorizedBy: "human" },
    // 与 auto_execute 路径的 authorizedBy: "policy" 相对——
    // 同一事件类型，授权来源不同，审计可辨。
  });

  // 从 approved 记录执行。executor 会再次守卫边界。
  const execution = executeAction(paths, approved);
  // executor 内部三道边界 + 参数复验 + 事实落盘（见 executor.ts）。
  // 如果工具抛错（如 Unknown order）：
  //   execution 不会产生 → 这里异常向上冒泡 →
  //   记录停留在 approved（不是 executed）→ 状态真实。

  const executed: ApprovalRecord = {
    ...approved,
    status: "executed",
    executionId: execution.executionId,
    updatedAt: nowIso(),
  };
  upsertApproval(paths, executed);
  // 只有走到这里（工具成功、事实已落盘）才翻成 executed。

  return { record: executed, execution, blocked: false };
}

/**
 * 拒绝一张 pending 审批单并要求填写理由。
 * 工具永不执行，且这张单除非创建新审批，否则不能再被批准。
 */
export function rejectApproval(
  paths: DataPaths,
  id: string,
  reason: string
): ApprovalRecord {
  // 拒绝理由属于审计上下文，因此不允许空字符串。
  if (!reason || reason.trim() === "") {
    // !reason 拦截 undefined/空串；trim() 拦截纯空白。
    // 为什么拒绝必须给理由、批准不用？
    //   批准 = "同意模型 + 编辑后的方案"，理由已存在于提案链中；
    //   拒绝 = 推翻提案，必须留下"凭什么"给后来者。
    throw new Error('A rejection reason is required (use --reason="...").');
  }
  const record = requirePending(paths, id, "reject");
  // 只有 pending 可拒绝——executed 的单没法"拒绝"（钱已经退了），
  // approved 理论上只存在于 approveApproval 的执行瞬间。

  const rejected: ApprovalRecord = {
    ...record,
    status: "rejected",
    decisionReason: reason,
    // 拒绝理由记录在单据上（decisionReason），
    // 同时也进审计事件（下面的 metadata）。
    updatedAt: nowIso(),
  };
  upsertApproval(paths, rejected);

  appendAudit(paths, {
    event: "ACTION_REJECTED",
    approvalId: rejected.id,
    toolName: rejected.proposedAction.toolName,
    metadata: { reason },
  });

  return rejected;
}

/** 把三个 store 恢复成干净的空演示状态。 */
export function resetDemo(paths: DataPaths): void {
  // reset 只用于学习环境清空三个 JSON store；生产系统不应提供这种无条件
  // 清空审计记录的能力。
  //
  // 注意"无条件清空审计"在生产里是合规红线：
  // 审计日志有法定保留期（不同司法辖区不同）。
  // 演示程序里 reset 让你可以反复重放同一故事线，
  // 生产系统最多提供"归档"，不提供"清零"。
  writeJsonArray(paths.approvals, []);
  writeJsonArray(paths.audit, []);
  writeJsonArray(paths.executions, []);
}

// ── 内部 helper ─────────────────────────────────────────────────────────
// 两个 require* 把重复的前置条件集中起来，
// 让 edit/approve/reject 的"找不到记录"错误信息保持一致。

function requireExisting(paths: DataPaths, id: string): ApprovalRecord {
  // 将重复的前置条件集中在内部 helper，保证 edit/approve/reject 的
  // "找不到记录"错误信息一致。
  const record = findApproval(paths, id);
  if (!record) {
    throw new Error(`No approval found with id "${id}".`);
  }
  return record;
}

function requirePending(
  paths: DataPaths,
  id: string,
  action: string
): ApprovalRecord {
  // requireExisting 之上再叠一层"必须是 pending"。
  // action 参数让错误消息带上具体操作名：
  //   `Cannot edit approval APR-001: it is "executed", not "pending".`
  // 调用方不需要自己拼错误消息。
  const record = requireExisting(paths, id);
  if (record.status !== "pending") {
    throw new Error(
      `Cannot ${action} approval ${id}: it is "${record.status}", not "pending".`
    );
  }
  return record;
}

function coerceNumber(field: string, value: string): number {
  // CLI 参数天然是字符串；这里只做最小类型转换，真正的正数/字段范围校验
  // 仍由 ActionProposalSchema 和工具层完成。
  //
  // "最小转换"的边界：这里只保证"是个数字"，
  // 不检查正负、不检查范围——那些是 Schema 的职责。
  // 每层只做自己的事，校验规则不会散落两处。
  const parsed = Number(value);
  // Number("49") → 49；Number("abc") → NaN；Number("") → 0！
  // 空串转 0 是 JS 的著名陷阱，好在空参数到不了这里
  // （CLI 层 flags 无值的 key 会是 "true"）。
  if (Number.isNaN(parsed)) {
    // NaN 是 JS 里唯一不等于自身的值：
    //   NaN === NaN → false
    // 所以判 NaN 要用 Number.isNaN()，不能用 === NaN。
    throw new Error(`Field "${field}" must be a number, got "${value}".`);
  }
  return parsed;
}

// ============================================================
//  本文件小结：状态机全景
// ============================================================
//
//  require_approval 路径：
//
//    handleProposal        editApproval        approveApproval
//    ─────────────   →    ────────────   →    ────────────────
//    创建 pending         pending 之间可编辑    pending → approved
//    （重复则复用）        （每改一次全量复验）   → 工具 → executed
//
//    rejectApproval
//    ─────────────
//    pending → rejected（终态，不可再批准）
//
//  auto_execute 路径：policy 授权 → approved → executed（同一条状态机）
//  deny 路径：无状态，只有审计事件 ACTION_DENIED
//
//  五个值得背下来的顺序原则：
//   1. 先审计提案，后审计判定（因果顺序）
//   2. 先落盘授权（approved），后执行工具
//   3. 工具成功 + 事实落盘后，才翻 executed
//   4. 编辑先整体复验，后写盘（要么全有要么全无）
//   5. 崩溃恢复永远"以事实（execution）修状态（approval）"
// ============================================================
