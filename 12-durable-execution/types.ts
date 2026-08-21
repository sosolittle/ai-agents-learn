// ============================================================
//  第十二章：数据契约（types.ts）
//  给"工作流状态"和"副作用账本"立规矩
//
//  🏠 生活化比喻：剧场后台的「账簿法定格式」。
//  进度白板（WorkflowRecord）每一栏怎么填、发票登记簿
//  （EffectRecord）每一行怎么记，全部钉死在格式规范里——
//  错一格、跳一步、"退款"行里塞"通知"内容，格式检查
//  （superRefine / 判别联合）当场打回。剧场最大的灾难
//  不是断电，而是断电后白板变得不可信——规矩立在前面，
//  断电后才对得起账。
//
//  学习目标：
//  1. 理解本章与第 11 章的接力关系：
//     11 章回答"这个动作允不允许执行"（policy/审批），
//     12 章回答"执行开始后，流程如何安全地活过崩溃"
//  2. 用封闭枚举 + .options 数组实现"步骤顺序只有一处真相"
//  3. 理解"结构校验"与"业务校验"的分层：
//     本文件的 Schema 只证明"字段存在、类型对"，
//     真正的业务规则在 steps.ts 的 validate_approval 里
//  4. 用 superRefine 给持久化状态加"不变量"（invariant）：
//     completedSteps 必须是有序前缀、完成的步骤必须留下结果
//  5. 用判别联合 + 字面量钉死，让"不可能的记录"无法通过校验
//
//  本文件在整个章节中的角色：
//  它定义两份持久化数据的形状——
//    WorkflowRecord（checkpoint：工作流走到哪了）
//    EffectRecord（账本：副作用实际发生过什么）
//  以及供观测用的事件（WorkflowEvent）。
//  本章最重要的两张存储，其可信度全部由这里的 Schema 背书。
//
//  这一章的核心结论（与数据契约直接相关）：
//  checkpoint 帮你记住"走到哪"，idempotency key 帮你证明"做没做过"。
//  两者回答不同的问题，谁也不能替代谁——
//  这个思想贯穿本文件的两个区块。
// ============================================================

import { z } from "zod";
// Zod：运行时校验库（z.enum/z.object/superRefine 等用法见 11 章
// types.ts 的详细介绍；本章重点讲新出现的 superRefine）。

// ─────────────────────────────────────────────────────────────────────────────
// 第一部分：工作流步骤
// ─────────────────────────────────────────────────────────────────────────────

// 一个封闭的、有序的枚举。`.options` 保留声明顺序，
// 所以它是"下一个步骤是什么"的唯一真相——
// runner 永远不会把顺序硬编码第二遍。
export const WorkflowStepSchema = z.enum([
  "validate_approval", // 校验审批输入（纯函数，无副作用）
  "execute_refund",    // 执行退款（副作用！幂等键守护）
  "send_confirmation", // 发确认通知（副作用！幂等键守护）
]);
// 这个枚举同时编码了两件事：
//   1. 有哪些步骤（枚举成员）
//   2. 步骤的先后顺序（声明顺序）
// 传统写法里"步骤列表"和"步骤顺序"常常分两处维护
// （一个 enum + 一个 order 常量），迟早漂移。
export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;
export const WORKFLOW_STEPS = WorkflowStepSchema.options;
// .options 是 Zod enum 的一个属性：原样的字面量数组
//   ["validate_approval", "execute_refund", "send_confirmation"]
// 它的类型是 readonly ["validate_approval", ...]——
// 顺序就是声明顺序，且和枚举本身是同一个对象派生的，
// 物理上不可能漂移。
//
// 全章所有"按顺序遍历步骤"的代码都用 WORKFLOW_STEPS，
// 没有任何地方再写一遍顺序——单一事实来源（single source of truth）。

// 刻意保持很小。没有 "crashed" 状态：一次真实的突然崩溃
// 永远没有机会持久化任何东西，所以真实的最后已知状态就是
// 崩溃前工作流所处的状态——通常是 "running"。
export const WorkflowStatusSchema = z.enum(["running", "completed", "failed"]);
// 为什么没有 "crashed"？这是本章最反直觉也最重要的一课：
//
//   崩溃 = 进程消失 = 没有任何代码运行 = 没有任何写入发生
//
//   想把状态写成 "crashed"，得有代码在崩溃瞬间执行写入——
//   但崩溃的定义就是代码不再执行。所以 "crashed" 状态物理上写不进去。
//   磁盘上的 status 只能是崩溃前的最后值（running）。
//
//   由此推出恢复逻辑的形态：
//     "running" 不代表"正在跑"，代表"最后一次被看到时在跑"。
//     恢复程序看到 running 就要自己判断：
//     这是在跑（别插手）还是刚崩（该接管）？
//     生产系统用租约（lease）/心跳（heartbeat）区分这两种 running。
//
//   failed 则不同：它是活着的进程捕获到业务错误后主动写入的
//   （见 workflowRunner.markFailed）——
//   "失败是应用选择记录'无法继续'；崩溃是应用已经不存在、无从选择。"
export type WorkflowStatus = z.infer<typeof WorkflowStatusSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// 第二部分：输入（第 11 章交接过来的已批准动作）
// ─────────────────────────────────────────────────────────────────────────────

// 上一个控制层（human-in-the-loop 审批）交接过来的东西的形状。
// 这只是结构契约——它也接受 "pending" 和 "rejected"，
// 因为本模块会自己重查业务规则（纵深防御）而不是盲目信任调用方。
// 严格的业务规则检查住在 steps.ts 的 validate_approval 步骤里。
export const ApprovalStatusSchema = z.enum(["pending", "approved", "rejected"]);
// 注意这里故意允许 pending/rejected —— 和直觉的"只准 approved"相反：
//
//   如果本 Schema 只接受 approved，那么"把 pending 误传进来"会在
//   结构层就被拒绝——看起来更安全？
//   但"结构校验"和"业务校验"就混在了一起：
//   改业务规则（比如某天允许 pending 直接跑）要动 types.ts。
//
//   本模块的分层：
//     types.ts   → 只管"字段齐不齐、类型对不对"（结构）
//     steps.ts   → 判定"这个输入允不允许执行"（业务）
//   输入带着 pending 进门没关系——它过不了 validate_approval 那一关，
//   而那一关是每一步执行前都会跑的（包括崩溃恢复后）。
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

export const ApprovedActionSchema = z
  .object({
    approvalId: z.string(),
    // 第 11 章的审批单 ID（APR-001）。它是"业务身份"——
    // 同一个审批只应启动一个工作流（见 workflowRunner.createWorkflow）。
    status: ApprovalStatusSchema,
    // 审批状态。结构层三个都收，业务层只放 approved。
    toolName: z.string(),
    // 注意这里是 z.string() 而不是 11 章的封闭枚举——
    // 本章不再关心"有哪些工具"，只处理一个已批准的退款动作。
    arguments: z
      .object({
        orderId: z.string(),
        amount: z.number(),
        currency: z.string(),
        reason: z.string(),
      })
      .strict(),
      // 参数对象 strict：多余字段直接拒绝。
      // 和外层（下面）双层 strict，与 11 章同一手法。
  })
  .strict();
export type ApprovedAction = z.infer<typeof ApprovedActionSchema>;
// ApprovedAction 就是 README 里"Example scenario"的那个 JSON：
//   { approvalId: "APR-001", status: "approved", toolName: "refundOrder",
//     arguments: { orderId, amount: 49, currency, reason } }
// 它是两章之间的接口：11 章产出它，12 章消费它。

// 工作流记录内部保存的"扁平化、持久化"的输入形式。
// 同样只是结构契约——业务规则由 validate_approval 步骤在
// 每次运行时重查，无论那是首次运行还是崩溃后的恢复。
export const WorkflowInputSchema = z
  .object({
    approvalId: z.string(),
    approvalStatus: z.string(),
    // 结构层放宽到 string（enum 在业务层查）——
    // 存进磁盘的是"当时的样子"，哪怕它已经不合法，
    // 也要能原样读回来让 validate_approval 给出准确的失败原因。
    toolName: z.string(),
    orderId: z.string(),
    amount: z.number(),
    currency: z.string(),
    reason: z.string(),
  })
  .strict();
export type WorkflowInput = z.infer<typeof WorkflowInputSchema>;
// 为什么要"扁平化"（把 arguments.orderId 提到顶层 orderId）？
//   ApprovedAction（嵌套）是给"交接"用的形状——和 11 章对齐；
//   WorkflowInput（扁平）是给"持久化+步骤消费"用的形状——
//   每个字段一行、validate_approval 的 Schema 直接对齐。
//   转换发生在 createWorkflow 的 toWorkflowInput（见 workflowRunner.ts）。
//   "接口形状跟对家走，存储形状跟消费者走。"

// ─────────────────────────────────────────────────────────────────────────────
// 第三部分：工作流记录（持久化的 checkpoint 状态）
// ─────────────────────────────────────────────────────────────────────────────

// 只有已完成的步骤才允许写入的东西。context 随步骤逐个
// checkpoint 增量构建——它永远不会包含尚未完成的步骤的数据。
export const WorkflowContextSchema = z
  .object({
    refundId: z.string().optional(),
    // execute_refund 完成后写入（REF-001...）
    confirmationId: z.string().optional(),
    // send_confirmation 完成后写入（MSG-001...）
  })
  .strict();
export type WorkflowContext = z.infer<typeof WorkflowContextSchema>;
// context 是"工作流自己的记账本"：每完成一个副作用步骤，
// 就把结果 ID 记进来。注意它和 effectStore 的账本是两本：
//
//   context（这里）      → 工作流视角："我知道我做完了 X"
//   effect ledger        → 提供方视角："X 确实发生了"
//   崩溃窗口的本质 = 这两本账暂时对不上（工作流还不知道）。
//   superRefine 里的"单向一致性"检查就是为这个窗口留的活口（见下）。

// 持久化的 checkpoint。`completedSteps`——而不是某个 `currentStep`
// 指针——是"从哪里恢复"的真相来源：它不会像单独追踪的
// 指针那样和自己失同步。
//
// 基础对象类型与下面带校验的 Schema 分开导出，
// 这样其他 Schema（以及错误消息）可以引用"一条工作流记录"
// 而不必每次重跑语义检查。
const WorkflowRecordShape = z
  .object({
    id: z.string(),
    // "WF-001" 式的顺序 ID。
    status: WorkflowStatusSchema,
    // running / completed / failed（没有 crashed，见上面）。
    input: WorkflowInputSchema,
    // 扁平化的输入（见上）。
    completedSteps: z.array(WorkflowStepSchema),
    // 已完成步骤的有序列表。恢复点 = WORKFLOW_STEPS 里第一个
    // 不在这个数组里的步骤。
    context: WorkflowContextSchema,
    // 已完成步骤留下的结果 ID。
    createdAt: z.string(),
    updatedAt: z.string(),
    lastError: z.string().optional(),
    // 只有 failed 状态填：最后一次业务错误的消息。
  })
  .strict();
//
// "completedSteps vs currentStep 指针"值得展开：
//   假设存 currentStep: "execute_refund"：
//     崩溃后 currentStep 说"该跑 execute_refund"——
//     但它跑完没有？不知道！指针只说"在哪"，不说"做完没有"。
//     要知道"做完没有"还得再存一个 completed 集合——
//     两个字段描述同一件事，就有失同步的机会。
//   只存 completedSteps：
//     "下一步"是推导出来的（第一个不在集合里的步骤），
//     推导不会失同步——没有第二份事实可以矛盾。
//   "能推导的状态不要单独存"是持久化设计的金律。

/** 仅当 `completed` 恰好是 WORKFLOW_STEPS 的前缀时为真——无空洞、无重复、无乱序。 */
function isValidCompletedPrefix(completed: WorkflowStep[]): boolean {
  return completed.every((step, index) => WORKFLOW_STEPS[index] === step);
  // every(回调)：每个元素都满足条件才返回 true。
  // 这里逐位比较：completed[i] 必须等于 WORKFLOW_STEPS[i]。
  //
  // 为什么"恰是有序前缀"这么重要？反例演示：
  //   ["validate_approval", "send_confirmation"]（跳步）
  //     → 恢复时找不到"第一个未完成"的合理位置，
  //       send_confirmation 可能带着不存在的 refundId 跑
  //   ["execute_refund", "validate_approval"]（乱序）
  //     → 业务上根本不可能（没验证就退款？），数据必被手改过
  //   ["validate_approval", "validate_approval"]（重复）
  //     → 两次 checkpoint 之间必然有 bug
  // 三种情况都是"被污染的 checkpoint"，正确处理是拒绝加载，
  // 而不是带着坏地图继续赶路。
}

// 这个 refinement 让损坏或手改的 checkpoint 加载失败，
// 而不是静默搞乱恢复逻辑。"completedSteps 决定下一步是什么"
// 只有在它永远只可能是工作流定义的有效前缀时才可信。
export const WorkflowRecordSchema = WorkflowRecordShape.superRefine((record, ctx) => {
  // superRefine 是 Zod 的"跨字段校验"工具：
  //   普通 .refine 只能对单个值说话；
  //   superRefine 拿到整个对象 record 和一个 ctx，
  //   可以针对多个字段的"联合关系"报多个错。
  // 它和 11 章的 z.discriminatedUnion 互补：
  //   判别联合管"形状互斥"，superRefine 管"语义一致"。
  if (!isValidCompletedPrefix(record.completedSteps)) {
    ctx.addIssue({
      // addIssue：登记一个校验问题（可以登记多个，
      // 一次 parse 报出全部问题——和 Zod 默认行为一致）。
      code: z.ZodIssueCode.custom,
      // custom：自定义问题类别（没有更精确的内置类别可用时）。
      path: ["completedSteps"],
      // path 指明问题出在哪个字段——错误消息里会带上路径，
      // 定位到字段而不是只说"这条记录不行"。
      message: "completedSteps must be an ordered prefix of the workflow definition",
    });
  }

  // context 必须与实际完成的步骤一致：完成的步骤必须留下
  // 它的结果。这刻意是单向的——幂等账本里存在一个 effect
  // 并不要求工作流 context 已经知道它。那个差距（提供方先知道、
  // checkpoint 后知道）正是本章要演示的崩溃窗口一课，
  // 所以像 `{ completedSteps: ["validate_approval"], context: {} }`
  // 这样一条记录、外加一个已在别处持久化的退款 effect，
  // 必须保持有效。
  //
  // 单向检查的两种方向对比：
  //   ✔ 检查：completedSteps 有 execute_refund ⇒ context.refundId 必在
  //     （说做完了就必须有收据——防"谎报完成"）
  //   ✘ 不检查：context.refundId 存在 ⇒ completedSteps 必有 execute_refund
  //     （这条不成立！崩溃窗口里 effect 已发生、checkpoint 还没记，
  //      如果禁止这种状态，恢复就永远无法自洽）
  if (record.completedSteps.includes("execute_refund") && !record.context.refundId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["context", "refundId"],
      message: "execute_refund is completed but context.refundId is missing",
    });
  }
  if (record.completedSteps.includes("send_confirmation") && !record.context.confirmationId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["context", "confirmationId"],
      message: "send_confirmation is completed but context.confirmationId is missing",
    });
  }

  if (record.status === "completed") {
    // 状态与进度的一致性：宣称完成 ⇒ 所有步骤确实都在。
    const allStepsDone = WORKFLOW_STEPS.every((step) => record.completedSteps.includes(step));
    if (!allStepsDone) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["status"],
        message: 'status is "completed" but not every workflow step is in completedSteps',
        // 拦截"谎报完成"：completed 但步骤没齐，
        // 恢复程序会以为无事可做直接跳过——副作用缺失无人察觉。
      });
    }
  }
});
export type WorkflowRecord = z.infer<typeof WorkflowRecordShape>;
// 注意类型从 Shape（不带 superRefine）推导：
//   superRefine 不改变类型（字段集合没变），
//   但每次 WorkflowRecordSchema.parse 都会跑全部语义检查。
//   类型用 Shape 推导避免无关场景（比如只想描述记录形状）
//   绑定重校验逻辑——和"基础对象类型与 refined schema 分开"的
//   注释意图一致。
//
// 📤 输入输出走查（superRefine 拦三种坏账，测试同款场景）：
//   坏账 A：completedSteps: ["validate_approval", "send_confirmation"]
//     （跳步——没退款就发通知？）→ 前缀检查失败，
//      path 指向 completedSteps ✗
//   坏账 B：completedSteps 含 execute_refund，context.refundId 缺失
//     （谎报完成——勾了"退款"却拿不出收据）→
//      path 指向 context.refundId ✗
//   坏账 C：status: "completed" 但步骤没齐
//     （虚报收工——谢幕了还有一幕没演）→ path 指向 status ✗
//   三种坏数据都在 loadWorkflows 读盘的瞬间被拒——
//   恢复逻辑永远只见到验过格式的干净白板。

// ─────────────────────────────────────────────────────────────────────────────
// 第四部分：幂等副作用（mock 下游提供方的账本）
// ─────────────────────────────────────────────────────────────────────────────

export const EffectTypeSchema = z.enum(["refund", "confirmation"]);
export type EffectType = z.infer<typeof EffectTypeSchema>;
// 两种副作用：退款 / 确认消息。

export const RefundEffectResultSchema = z
  .object({
    refundId: z.string(),
    orderId: z.string(),
    amount: z.number(),
    currency: z.string(),
    status: z.literal("processed"),
    // 字面量 "processed"：账本只记"成功发生的退款"。
    // 失败的退款不进账本（没发生就是没发生）。
    mock: z.literal(true),
    // z.literal(true) 而不是 z.boolean()：
    // 这个字段只能是真的 true——它是类型层面的"mock 标记"，
    // 不可能出现 { mock: false } 的账本记录。
  })
  .strict();
export type RefundEffectResult = z.infer<typeof RefundEffectResultSchema>;

export const ConfirmationEffectResultSchema = z
  .object({
    confirmationId: z.string(),
    orderId: z.string(),
    status: z.literal("sent"),
    mock: z.literal(true),
  })
  .strict();
export type ConfirmationEffectResult = z.infer<typeof ConfirmationEffectResultSchema>;

// 一个以 `type` 为键的判别联合，所以退款记录永远不可能
// 装着确认形状的结果，反之亦然。`step` 还在各自的分支里
// 被钉死成字面量——退款 effect 只能标记 "execute_refund"、
// 确认 effect 只能标记 "send_confirmation"——
// 所以像 `{ type: "refund", step: "send_confirmation" }` 这样
// 不可能的记录会校验失败，而不是悄悄持久化。
// `key` 是幂等键（例如 "WF-001:execute_refund"）——
// 它是 mock 提供方自己的查询键，而不只是工作流侧的便利字段。
export const EffectRecordSchema = z.discriminatedUnion("type", [
  // 判别联合（11 章详解过）：先看 type 路由到唯一分支。
  // 这里再加一层设计：分支里连 step 都用 literal 钉死——
  //
  //   refund 分支:      type: "refund",      step: 字面量 "execute_refund"
  //   confirmation 分支: type: "confirmation", step: 字面量 "send_confirmation"
  //
  //   "type 和 step 必须配对"这条业务规则被编码进了类型结构：
  //   不可能构造出（通过校验的）错配记录。
  //   把规则从"运行时 if 检查"提升到"Schema 结构"，
  //   连检查代码都省了。
  z
    .object({
      key: z.string(),
      // 幂等键："WF-001:execute_refund"。
      // 由 effectStore.idempotencyKey(workflowId, step) 生成。
      workflowId: z.string(),
      // 归属的工作流。
      step: z.literal("execute_refund"),
      type: z.literal("refund"),
      result: RefundEffectResultSchema,
      createdAt: z.string(),
    })
    .strict(),
  z
    .object({
      key: z.string(),
      workflowId: z.string(),
      step: z.literal("send_confirmation"),
      type: z.literal("confirmation"),
      result: ConfirmationEffectResultSchema,
      createdAt: z.string(),
    })
    .strict(),
]);
export type EffectRecord = z.infer<typeof EffectRecordSchema>;
// EffectRecord 是"账本的一行"。整个 effectStore 就是一个
// EffectRecord 数组。判别联合的好处再次体现：
//   const effect = ...;
//   if (effect.type === "refund") {
//     // 这里 effect.result 一定有 refundId/amount
//     // effect.step 一定是 "execute_refund"
//   }
//   类型收窄一步到位，消费代码零防御性判断。

// ─────────────────────────────────────────────────────────────────────────────
// 第五部分：事件日志（生命周期可观测性）
// ─────────────────────────────────────────────────────────────────────────────

export const WorkflowEventTypeSchema = z.enum([
  "WORKFLOW_CREATED",     // 工作流被创建
  "WORKFLOW_STARTED",     // 首次开跑
  "WORKFLOW_RESUMED",     // 崩溃/中断后恢复
  "STEP_STARTED",         // 某步骤开始
  "STEP_COMPLETED",       // 某步骤完成并 checkpoint
  "STEP_FAILED",          // 某步骤业务失败
  "SIDE_EFFECT_EXECUTED", // 副作用真实发生（新执行）
  "SIDE_EFFECT_REUSED",   // 副作用被复用（幂等命中）
  "WORKFLOW_COMPLETED",   // 全部步骤完成
]);
// 和 11 章审计事件的分工：
//   11 章 AuditEvent → 审批生命周期（提案/批准/拒绝/执行）
//   12 章 WorkflowEvent → 工作流生命周期（步骤/checkpoint/恢复）
// 两个系统交接处（APR-001 → WF-001）各有各的日志，
// 出问题时两侧时间线能对上。
export type WorkflowEventType = z.infer<typeof WorkflowEventTypeSchema>;

export const WorkflowEventSchema = z
  .object({
    event: WorkflowEventTypeSchema,
    timestamp: z.string(),
    workflowId: z.string(),
    // 每条事件必须挂在工作流上（11 章的 approvalId 是可选的，
    // 因为提案阶段还没有审批单；这里创建即有 ID）。
    step: WorkflowStepSchema.optional(),
    // 步骤级事件才有；工作流级事件没有。
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();
export type WorkflowEvent = z.infer<typeof WorkflowEventSchema>;
// appendEvent 同样"时间戳由应用盖章"（见 eventLog.ts），
// Schema 的 .strict() 保证事件结构永不漂移。

// ============================================================
//  本文件小结：两本账 + 一份时间线
// ============================================================
//
// | 存储            | 文件              | 回答什么                  |
// |-----------------|-------------------|---------------------------|
// | checkpoint      | workflows.json    | 工作流走到哪一步了？       |
// | effect 账本     | effects.json      | 副作用实际发生过什么？     |
// | 事件日志        | events.json       | 全过程按时间怎么走的？     |
//
// Schema 层的四个不变量（由 superRefine / literal 保证）：
//  1. completedSteps 必须是有序前缀（无洞/无重/无乱序）
//  2. 完成的步骤必须留下 context 结果（不许谎报完成）
//  3. "completed" 状态 ⇒ 所有步骤确实完成
//  4. effect 的 type 与 step 必须配对（结构上不可能错配）
//
// 刻意允许的一个"不一致"：
//  effect 账本有退款、工作流 context 还不知道——
//  这不是漏洞，这是崩溃窗口本身，恢复机制靠它工作。
// ============================================================
