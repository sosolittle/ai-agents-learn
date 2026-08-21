// ============================================================
//  第十一章：数据契约（types.ts）
//  把"自然语言请求"变成"可验证的数据结构"
//
//  🏠 生活化比喻：审批处所有单据的「表格式样册」。
//  每种单据都是一张印好格子的表格：哪些格必填、各填什么类型、
//  哪些格根本没印（模型想填"我不需要审批"？表上没这个格子，
//  印表器直接把单子作废）。Zod Schema 就是表格的"电子模具"：
//  纸面数据过不了模具，连进文件柜的资格都没有。
//  全章五类单据的式样全部钉在本文件——改一张表，全楼的
//  校验规则跟着变，这就是"契约集中"的含义。
//
//  学习目标：
//  1. 理解什么是"数据契约"：为什么 agent 系统的每个对象都要有 Schema
//  2. 用 discriminated union（判别联合）把"工具名"和"参数结构"绑定起来
//  3. 区分四类容易混淆的对象：
//     - ActionProposal（模型提案：想调用什么工具）
//     - PolicyResult（策略判定：这个工具允许怎么执行）
//     - ApprovalRecord（审批记录：这次申请走到哪一步了）
//     - ExecutionRecord（执行记录：工具是否真的运行过）
//  4. 理解 TypeScript 类型与 Zod Schema 的分工：
//     TS 类型只在编译期存在（写给编译器看），
//     Zod Schema 在运行时校验真实数据（写给边界看）
//  5. 用 .strict() 拒绝未知字段，防止模型自己"投票"授权
//
//  本文件在整个章节中的角色：
//  它是所有其他模块的"词汇表"。actionAgent 产出 ActionProposal，
//  policy 消费 toolName 产出 PolicyResult，approvalService 读写
//  ApprovalRecord，executor 写 ExecutionRecord，auditLog 追加 AuditEvent。
//  每个模块之间的每次交接都要经过这里定义的 Schema 校验——
//  这就是"边界即契约"：模块内部可以自由实现，模块之间只说 Schema 语言。
//
//  这一章的核心结论（与数据契约直接相关）：
//  ActionProposal 里刻意没有 requiresApproval / isAuthorized / allowed
//  这类字段。模型可以提出"调用 refundOrder"，但无权声明"这不需要审批"。
//  想让模型越权？Schema 在运行时直接拒绝。
// ============================================================

import { z } from "zod";
// zod 是 TypeScript 生态里最流行的运行时校验库
//
// 为什么有了 TypeScript 类型还需要 Zod？
//   TS 类型只在你写代码、编译的时候起作用。
//   但是 agent 系统里有大量"运行时才出现的数据"：
//     - 模型返回的 JSON（模型可能输出任何东西）
//     - 磁盘上读回的 JSON 文件（可能被手改过、可能损坏）
//     - CLI 传进来的参数（天然全是字符串）
//   这些数据不受 TS 类型保护——你用 `as` 断言只是在"骗编译器"。
//   Zod Schema 在运行时逐字段检查真实数据，不合格就抛错。
//
// zod 的常见用法一共有三种，本文件全部用到了：
//   1. z.enum / z.object / z.string() ...  → 定义 Schema（数据形状）
//   2. Schema.parse(data)                  → 校验并收窄类型，失败抛错
//   3. z.infer<typeof Schema>              → 从 Schema 反推出 TS 类型
//
// 第 3 种特别值得注意：我们"只写一份 Schema"，
// TS 类型由 z.infer 自动推导，保证"运行时校验规则"和"编译期类型"
// 永远一致，不会出现两处定义各自漂移的问题。

// ─────────────────────────────────────────────────────────────────────────────
// 第一部分：工具清单（封闭枚举）
// ─────────────────────────────────────────────────────────────────────────────

// 支持的工具是一个封闭枚举（closed enum）。
// 模型只能从这四个里选；任何其他工具名都会在验证边界被直接拒绝，
// 根本走不到策略检查或执行器。
export const ToolNameSchema = z.enum([
  "getOrderStatus",        // 查询订单状态（只读，无副作用）
  "refundOrder",           // 退款（动钱，需要人工审批）
  "cancelSubscription",    // 取消订阅（改账户，需要人工审批）
  "deleteProductionUsers", // 删除生产用户（破坏性，直接禁止）
]);
// z.enum([...]) 接收一个字符串字面量数组，生成一个
// "只接受这几个值"的 Schema。注意数组里是字符串字面量而不是变量——
// 这样 Zod（配合 as const 的类型推导）才能知道每个合法值是什么。
//
// 为什么用"封闭枚举"而不是"随便一个字符串"？
//   如果 toolName 是 z.string()，那么"dropDatabase"、"rm -rf"这类
//   工具名都能通过校验，后面的代码就要层层设防。
//   把合法值收窄到四个，非法值在第一道门就被拦下，
//   下游代码只需要处理已知情况。

export type ToolName = z.infer<typeof ToolNameSchema>;
// z.infer<typeof X> 的意思是"从 Schema X 反推出它校验通过后的类型"。
// 这里 ToolName 等价于手写的：
//   type ToolName = "getOrderStatus" | "refundOrder"
//                 | "cancelSubscription" | "deleteProductionUsers";
// 但它永远和 ToolNameSchema 保持同步——往枚举里加一个工具，
// 这个联合类型自动跟着变，不需要手改两处。

// 共用的 ID 形状约束。格式错误的 ID 在这里就失败，
// 不会混进工具层当"看起来合法的参数"。
const OrderIdSchema = z
  .string()
  .regex(/^ORD-\d+$/, 'orderId must look like "ORD-001"');
// z.string().regex(正则, 错误消息)
//   先要求是字符串，再用正则检查形状。
//   /^ORD-\d+$/ 的含义：
//     ^      → 从头开始
//     ORD-   → 必须以字面量 "ORD-" 开头
//     \d+    → 后面跟一个或多个数字
//     $      → 到此结束，后面不能有别的东西
//   所以 "ORD-001" 合法，"ORD-1" 也合法，"ord-001"、"ORD-001 " 都不合法。
//
// 第二个参数是自定义错误消息。当校验失败时，Zod 会把这句话放进
// 错误详情里，调用方（比如 safeJsonParse）再拼成人类可读的报错。
// 好的错误消息是校验层的一半价值：它直接告诉模型/开发者怎么改。

const CustomerIdSchema = z
  .string()
  .regex(/^CUS-\d+$/, 'customerId must look like "CUS-104"');
// 客户 ID 的约束和订单 ID 同理："CUS-" 前缀 + 数字。
// 注意这两个 Schema 没有 export——它们只在本文件内部被组合使用，
// 外部模块不需要（也不应该）单独依赖它们。
// 最小暴露原则：不是给外部用的东西就不导出。

// ─────────────────────────────────────────────────────────────────────────────
// 第二部分：动作提案（模型的输出）
// ─────────────────────────────────────────────────────────────────────────────

// 以 toolName 为判别字段的 discriminated union（判别联合）。
// 每个工具有自己的参数结构，所以"给错工具的参数"会直接校验失败。
// .strict() 应用在"两层"：内层 arguments 对象和外层提案对象。
// 外层 .strict() 正是用来拒绝 requiresApproval、isAuthorized、allowed
// 这类隐藏的权限字段——模型永远不被允许决定这些。
// 模型提出 capability（能力）；授权 permission（权限）归应用所有。
export const ActionProposalSchema = z.discriminatedUnion("toolName", [
  // 什么是 discriminated union（判别联合）？
  //
  // 普通的 z.union([A, B]) 会"逐个尝试"每个分支，直到某个匹配。
  // 而 z.discriminatedUnion("toolName", [...]) 用 toolName 字段当
  // "判别器"：先读 toolName 的值，直接跳到唯一对应的分支去校验。
  //
  // 好处有两个：
  //   1. 更快（不需要逐个试错）
  //   2. 错误信息更准——报错来自唯一相关的分支，
  //      而不是"所有分支都不匹配"的一堆堆叠信息
  //
  // toolName 是判别字段。Zod 先看工具名，再选择唯一对应的参数 Schema；
  // 因此 refundOrder 不可能误带 cancelSubscription 的参数结构。
  z
    .object({
      toolName: z.literal("getOrderStatus"),
      // z.literal("getOrderStatus")：这个字段的值必须"字面上等于"
      // "getOrderStatus"。在判别联合里，每个分支的判别字段都用 literal
      // 钉死自己，这样 Zod 才能靠它路由到正确分支。
      arguments: z.object({ orderId: OrderIdSchema }).strict(),
      // 内层 .strict()：arguments 对象里只允许出现 orderId。
      // 多出来的任何字段（比如模型幻想出来的 include) 都会导致校验失败。
      reason: z.string().min(1),
      // min(1)：reason 必须是非空字符串。
      // 提案理由要进审计日志，空理由等于没有留下"为什么这么做"的证据。
    })
    .strict(),
    // 外层 .strict()：提案对象本身只允许 toolName / arguments / reason
    // 三个字段。这一层是防止模型越权的关键：
    //
    //   假如模型输出了 { ..., requiresApproval: false }
    //   → 外层 strict 校验失败 → 整个提案被拒绝
    //
    //   即使 prompt 没有提醒、模型"自作主张"夹带了权限字段，
    //   Schema 也兜得住。prompt 是引导，Schema 才是边界。
  z
    .object({
      toolName: z.literal("refundOrder"),
      arguments: z
        .object({
          orderId: OrderIdSchema,
          amount: z.number().positive("refund amount must be greater than 0"),
          // positive()：金额必须是 > 0 的数字。
          // "退款 -10 欧元"（等于向客户扣款）在数据形状这一层就被否决。
          // 注意：Zod 只管"是个正数"，不管"是否超过订单总额"——
          // 那是业务规则，由 tools.ts 里的 refundOrder 在有订单数据
          // 可查的地方检查。层次分工：形状约束在 Schema，业务约束在工具。
          currency: z.literal("EUR", {
            errorMap: () => ({ message: 'currency must be "EUR"' }),
          }),
          // errorMap 是 Zod 自定义错误消息的另一种写法。
          // 对 z.literal 来说默认报错是"invalid literal value"，
          // 对用户不友好，所以这里改写成一句明确的话。
          // 本演示系统只支持欧元，多币种系统这里会是
          // z.enum(["EUR","USD",...]) 加汇率/精度处理。
          reason: z.string().min(1),
        })
        .strict(),
      reason: z.string().min(1),
    })
    .strict(),
  z
    .object({
      toolName: z.literal("cancelSubscription"),
      arguments: z
        .object({
          customerId: CustomerIdSchema,
          reason: z.string().min(1),
        })
        .strict(),
      reason: z.string().min(1),
    })
    .strict(),
  z
    .object({
      toolName: z.literal("deleteProductionUsers"),
      arguments: z.object({}).strict(),
      // 破坏性工具没有任何参数。空对象 + strict 意味着
      // 连一个多余字段都不接受——它的"参数空间"为零。
      // 当然这个工具最终被 policy 直接 deny（见 policy.ts），
      // 这里保留它只是为了演示"提案层能识别它、策略层禁止它"。
      reason: z.string().min(1),
    })
    .strict(),
]);
export type ActionProposal = z.infer<typeof ActionProposalSchema>;
// 由 z.infer 推导出的 ActionProposal 是一个判别联合类型。
// 它的最大价值是"类型收窄"（narrowing）：
//
//   const proposal: ActionProposal = ...;
//   if (proposal.toolName === "refundOrder") {
//     // 在这个分支里，TypeScript 知道 proposal.arguments
//     // 一定有 orderId/amount/currency/reason 四个字段，
//     // 可以直接用 proposal.arguments.amount 而不需要断言。
//   }
//
// "判别字段 + 联合类型"是处理"多种形态数据"的标准手法，
// 和第一章里 Anthropic 响应的 content 数组（text 块 / tool_use 块）
// 是同一个思想：先看类型标记，再按对应形状处理。
//
// 📤 输入输出走查（同一张表格的两种命运）：
//   输入 A：{ toolName: "refundOrder",
//            arguments: { orderId: "ORD-001", amount: 79,
//                         currency: "EUR", reason: "damaged" },
//            reason: "Customer requests a refund" }
//     → 判别器读到 refundOrder → 路由到退款分支 → 逐格核对全过 ✓
//     → parse 返回收窄后的类型：amount 此后是 number
//   输入 B：输入 A 再偷偷多塞一个 requiresApproval: false
//     → 外层 .strict() 发现"表格上没印这个格子" ✗
//     → ZodError: Unrecognized key 'requiresApproval'
//   A 成为下游可信赖的数据；B 连门都进不来——
//   "prompt 是引导，Schema 才是边界"的具体形状。

// ─────────────────────────────────────────────────────────────────────────────
// 第三部分：策略（Policy）
// ─────────────────────────────────────────────────────────────────────────────

// 确定性策略门的三种结论。它由应用代码决定，永远不由模型决定。
export const PolicyDecisionSchema = z.enum([
  "auto_execute",      // 只读/无副作用 → 免审批直接执行
  "require_approval",  // 动钱/改账户/对外可见 → 必须人工审批
  "deny",              // 破坏性 → 直接禁止，连审批队列都不进
]);
// 为什么三种而不是两种（允许/禁止）？
//   因为"需要人来看一眼"和"机器可以自己跑"是两种完全不同的信任等级，
//   压缩成"允许"会丢掉最重要的信息：这个动作值不值得人花时间审。
//   三档划分对应三种处理路径，approvalService 的分支和它一一对应。
//
// 注意 deny 和后面审批状态里的 rejected 是两回事：
//   deny    → 系统策略直接禁止（动作根本不进入人工队列）
//   rejected→ 已经进入人工队列后，被审核人拒绝的具体申请

export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;

export interface PolicyResult {
  // 这里用 interface 而不是 Zod Schema：PolicyResult 只在进程内部
  // 产生和消费（policy.ts 返回 → approvalService 使用），
  // 从不跨越"磁盘/网络/模型输出"这类不可信边界，
  // 所以只需要编译期类型，不需要运行时校验。
  //
  // 经验法则：数据一旦要"离开内存"（落盘、联网、来自模型），
  // 用 Zod；纯内部传递的对象用 interface 就够了。
  decision: PolicyDecision;
  // 三种决策之一，由 policy.ts 里的查表得到。
  reason: string;
  // 人类可读的理由，会进入审计日志。
  // "为什么允许/为什么禁止"必须可解释——审计时只看到结论看不到
  // 理由的日志，几乎无法复盘事故。
}

// ─────────────────────────────────────────────────────────────────────────────
// 第四部分：审批记录（持久化的工作流状态）
// ─────────────────────────────────────────────────────────────────────────────

export const ApprovalStatusSchema = z.enum([
  "pending",   // 待审核：等待人类决定
  "approved",  // 已授权：权限已授予，但副作用未必完成
  "rejected",  // 已拒绝：永久阻断，这张单不能再被批准
  "executed",  // 已执行：工具成功运行，执行记录已存在
]);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;
// 正常人工审批路径：
// pending（待审核）→ approved（已授权）→ executed（已执行）
//                    ↘ rejected（已拒绝）
//
// approved 与 executed 必须分开：授权成功不代表副作用已经成功完成。
//   假设只有 "approved" 一个状态：
//     人工批准 → 工具抛错 → 状态还是 approved
//     → 系统看起来"办完了"，实际退款没发生——状态在说谎。
//   拆成两个状态后：
//     批准 → approved（已授权未执行）
//     工具成功 → executed（真的执行了）
//     工具失败 → 停留在 approved，准确表达"已获准但未完成"，
//     后续可以安全重试（executor 会发现没有执行记录，重新执行）。
//
// 这是状态机设计的基本原则：状态必须"真实"，
//宁可少报进度（approved 但卡住），不可多报进度（谎称 executed）。

// 存进审批记录里的"动作"。这里的 arguments 用开放记录（z.record），
// 因为一张记录可能装任何工具的参数；确切形状在动作即将变更或执行时，
// 都会用 ActionProposalSchema 重新校验。
export const ProposedActionSchema = z.object({
  toolName: ToolNameSchema,
  arguments: z.record(z.unknown()),
  // z.record(z.unknown()) 表示"任意键值对的对象"——
  // { orderId: "ORD-001" } 可以，{ foo: 1, bar: [2,3] } 也可以。
  //
  // 为什么这里放松了约束？两个原因：
  //   1. ApprovalRecord 要能装下四种工具的参数，四种结构各不相同，
  //      写成判别联合会让记录 Schema 复杂很多；
  //   2. 更重要的是校验时机：参数真正要"用"的时候（编辑后、执行前）
  //      会走 ActionProposalSchema 重新校验（见 approvalService /
  //      executor / runTool）。存的时候宽松、用的时候严格，
  //      每个副作用边界都有硬校验兜底。
  //
  // 这是一个常见的持久化模式：存储层用宽类型保灵活性，
  // 使用层用严 Schema 保安全，两层之间的"转换点"就是校验点。
  reason: z.string(),
});
// 注意这个对象没有 .strict()——因为它的主要用途是"从磁盘读回来时
// 做基本形状检查"，而 arguments 本身就是开放的。
// 真正的安全边界在 ActionProposalSchema，那里是双 strict。

export type ProposedAction = z.infer<typeof ProposedActionSchema>;

export const ApprovalRecordSchema = z.object({
  // 审批记录回答"这项动作当前走到哪一步"，它是工作流状态。
  id: z.string(),
  // 形如 "APR-001" 的顺序 ID，由 approvalStore.nextApprovalId 分配。
  // CLI 命令（edit/approve/reject）都用它定位记录。
  originalRequest: z.string(),
  // 用户的原始请求原文。审计时需要把"用户要什么"和"模型提议做什么"
  // 放在一起对照——只有提案没有原话，无法判断提案是否答非所问。
  proposedAction: ProposedActionSchema,
  // 模型提议（可能经人工编辑）的具体动作：工具名 + 参数 + 理由。
  status: ApprovalStatusSchema,
  // 当前状态机位置：pending / approved / rejected / executed。
  createdAt: z.string(),
  updatedAt: z.string(),
  // ISO 格式时间戳（utils.nowIso()）。
  // 有两个时间字段是因为记录会被多次更新（编辑/批准/执行），
  // 创建时间和最后修改时间各有各的审计价值。
  decisionReason: z.string().optional(),
  // 只有 rejected 状态会用到：审核人填写的拒绝理由。
  // optional() 表示字段可以缺失——大多数状态下它不存在。
  executionId: z.string().optional(),
  // 只有 executed 状态会用到：指向执行记录（EXE-xxx）的链接。
  // 它是"审批状态"和"执行事实"两个存储之间的外键。
  // 有了它，从审批单一眼能看到工具结果存在哪里。
});
export type ApprovalRecord = z.infer<typeof ApprovalRecordSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// 第五部分：执行记录（不可变的事实）
// ─────────────────────────────────────────────────────────────────────────────

export const ExecutionRecordSchema = z.object({
  // 执行记录回答"工具是否已经真正运行过以及结果是什么"。
  // approvalId 将一次执行绑定到一张审批单，是本地幂等恢复的依据。
  //
  // 为什么审批状态和执行事实要分成两个文件存？
  //   考虑这个崩溃窗口：
  //     1. 人工批准，approval 落盘为 approved
  //     2. 工具成功执行，execution 记录落盘        ← 到这里都完成了
  //     3. 进程在把 approval 更新为 executed 之前崩溃 ← 这里挂了
  //   重启后重试 approve：
  //     - approval 是 approved，但 findExecutionByApprovalId 能找到
  //       已有执行 → 复用结果，把状态补齐为 executed，不再退款
  //   如果两者存在同一个对象里，第 2 步和第 3 步就无法分开落盘，
  //   崩溃恢复就没有"事实锚点"可用。
  id: z.string(),
  // 形如 "EXE-001" 的顺序 ID，标识"这一次工具运行"。
  approvalId: z.string(),
  // 外键：这次执行对应哪张审批单。幂等查找就靠这个字段。
  toolName: ToolNameSchema,
  // 实际执行的工具名。执行记录必须记录"当时真正跑了什么"，
  // 而不是回头去查审批单——审批单可能已被编辑或推进。
  arguments: z.record(z.unknown()),
  // 执行时的实际参数快照。注意这是"执行那一刻"的参数，
  // 之后审批单再怎么改，执行记录不变——它是历史事实。
  result: z.record(z.unknown()),
  // 工具返回的结果（如 refundId、status: "processed"）。
  // 用开放记录是因为不同工具返回结构不同。
  executedAt: z.string(),
  // 执行时间戳。
});
export type ExecutionRecord = z.infer<typeof ExecutionRecordSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// 第六部分：审计日志事件（只追加的时间线）
// ─────────────────────────────────────────────────────────────────────────────

export const AuditEventTypeSchema = z.enum([
  "ACTION_PROPOSED",             // 模型提出了一个动作
  "POLICY_EVALUATED",            // 策略门给出了判定
  "APPROVAL_REQUESTED",          // 创建了 pending 审批单
  "ACTION_EDITED",               // 人工编辑了参数
  "ACTION_APPROVED",             // 人工/策略授予了权限
  "ACTION_REJECTED",             // 人工拒绝了申请
  "ACTION_DENIED",               // 策略直接禁止（不产生审批单）
  "ACTION_EXECUTED",             // 工具真正执行了
  "DUPLICATE_EXECUTION_BLOCKED", // 重复审批被拦截
  "EXISTING_EXECUTION_RECOVERED",// 崩溃恢复：复用了已有执行
]);
export type AuditEventType = z.infer<typeof AuditEventTypeSchema>;
// 这十种事件正好覆盖了整个生命周期，连"被阻止的事"也记录在案：
//   - 被禁止的提案 → ACTION_DENIED
//   - 被拦截的重复执行 → DUPLICATE_EXECUTION_BLOCKED
//   - 被恢复的执行 → EXISTING_EXECUTION_RECOVERED
// 审计日志的价值一半在于"发生了什么"，另一半在于
// "系统阻止了什么"——安全系统的"未遂事件"和"既遂事件"同样重要。

export const AuditEventSchema = z.object({
  // 审计事件是只追加的时间线，不承担当前状态查询；
  // 当前状态看 ApprovalRecord，历史过程看 AuditEvent。
  //
  // 为什么不只用审计日志推导当前状态？
  //   1. 每次查询都要重放全部事件，慢且容易错；
  //   2. "当前状态"和"历史过程"的变更频率完全不同——
  //      状态会被覆盖更新，历史只增不改。
  //   分开存储后，ApprovalRecord 可以随意 upsert，
  //   AuditEvent 永远 append-only（只追加）。
  //   这和第 12 章的事件日志（eventLog.ts）是同一个思想。
  event: AuditEventTypeSchema,
  // 上面十种事件类型之一。
  timestamp: z.string(),
  // ISO 时间戳。注意它由 appendAudit 在写入时盖章，
  // 不信任调用方传入（保证格式统一、不可伪造时间）。
  approvalId: z.string().optional(),
  // 关联的审批单。提案/策略这类"审批单还不存在"的事件没有这个字段。
  toolName: ToolNameSchema.optional(),
  // 涉及的工具名（如果有）。
  metadata: z.record(z.unknown()).optional(),
  // 自由上下文：参数快照、before/after、拒绝理由等。
  // 用开放记录是因为不同事件携带的上下文差异很大；
  // 它只用于人读审计，不参与控制流决策。
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

// ============================================================
//  本文件小结：四类对象一张表
// ============================================================
//
// | 对象             | 回答的问题                     | 由谁决定         |
// |------------------|--------------------------------|------------------|
// | ActionProposal   | 调用什么工具、参数是什么？     | 模型（过 Zod）   |
// | PolicyResult     | 这个工具允许怎样执行？         | 代码查表         |
// | ApprovalRecord   | 这次申请当前走到哪一步？       | 工作流推进       |
// | ExecutionRecord  | 工具是否真的执行过、结果？     | executor 写入    |
// | AuditEvent       | 全过程中发生过什么？           | 各边界追加       |
//
// 阅读建议：接下来看 actionAgent.ts（模型如何产出 ActionProposal），
// 再看 policy.ts（toolName 如何映射到 PolicyResult）。
// ============================================================
