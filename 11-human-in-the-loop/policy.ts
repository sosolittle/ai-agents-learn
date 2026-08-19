// ============================================================
//  第十一章：策略门（policy.ts）
//  用确定性代码决定执行权限
//
//  学习目标：
//  1. 理解 policy 是授权边界，不是另一个 Agent
//     —— 它是一张普通的查找表，不调模型、不看 prompt
//  2. 用 Record<ToolName, ...> 强制"每个工具都有明确策略"，
//     新增工具却忘了配策略时，编译器直接报错
//  3. 掌握 auto_execute / require_approval / deny 三种决策的划分逻辑
//  4. 学会"默认拒绝"（fail closed）：没配策略的工具一律 deny
//
//  本文件在整个章节中的角色：
//  它是"capability → permission"的翻译器。actionAgent 产出
//  "我想调 refundOrder"，本文件回答"refundOrder 必须人工审批"。
//  没有任何模糊空间：同样的输入永远得到同样的输出。
//
//  这一课的核心结论：
//  权限判定必须"确定性、可审计、可测试"。
//  一张代码表三者兼备；一句 prompt 三者皆无。
// ============================================================

import type { PolicyDecision, PolicyResult, ToolName } from "./types.js";
// 只导入类型（type 前缀），本文件不产生任何运行时依赖。
// policy.ts 是纯逻辑模块：不读文件、不联网、不调模型。

// 策略门。这是本课核心的化身：capability 不等于 permission。
// 模型决定"哪个工具可能满足请求"；这张表——
// 纯应用代码，不是 prompt——决定该工具能否自动运行、
// 需要人工，还是被禁止。
//
// 它是确定性的、类型化的、扩展起来轻而易举：
// 加一个工具，就加一条策略。
// 判定从不依赖模型对"它想做什么"的解释。
const TOOL_POLICIES: Record<ToolName, PolicyResult> = {
  // Record<ToolName, PolicyResult> 的含义：
  // "一个对象，键必须是 ToolName 联合里的每一个值，
  //  值必须是 PolicyResult"。
  //
  // Record 的键是 ToolName：以后给 ToolNameSchema 新增工具却忘记配置策略时，
  // TypeScript 会直接报错，而不是让新工具默认为"可以执行"。
  // 这是"让类型系统当安全员"的经典手法：
  //   把"必须为每个 X 做出决定"编码进类型，
  //   漏掉任何一个 X，编译都过不去。
  //   对比 Record<string, PolicyResult>：少配一个键没人知道，
  //   运行时取到 undefined，静默走默认分支——危险。
  //
  // 三档决策的划分标准（可以当成清单套用到任何系统）：
  //   auto_execute    → 只读 / 无副作用 / 可随意重放
  //   require_approval→ 动钱 / 改账户状态 / 对外可见 / 不可逆但可控
  //   deny            → 破坏性 / 影响面不可控 / 没有合法业务理由

  // 只读查询，无副作用：没有人审也可以安全运行。
  getOrderStatus: {
    decision: "auto_execute",
    reason: "Read-only status lookup with no side effects.",
    // 查订单状态像"查字典"：跑一百次结果一样，不改任何数据。
    // 对这类动作要求人工审批，等于把审批人的时间浪费在
    // 零风险操作上，反而让真正的风险动作得不到足够注意力。
  },
  // 资金变动：永不自动，永远是人的决定。
  refundOrder: {
    decision: "require_approval",
    reason: "Financial actions cannot execute automatically.",
    // 退款三个不可辩护的风险点：
    //   1. 直接造成资金流出（错了要追回）
    //   2. 模型可能被诱导（社交工程 prompt 攻击的首要目标）
    //   3. 金额是连续值，错多少都是错（不存在"差不多对"）
    // 所以"模型提案 + 人类点头"是底线配置。
  },
  // 改变账户状态且对外可见：需要人工。
  cancelSubscription: {
    decision: "require_approval",
    reason: "Account-changing actions cannot execute automatically.",
    // 不动钱，但改变客户的服务状态——
    // 客户会立刻感知（服务消失），操作可逆性差（恢复订阅 ≠ 没发生）。
    // "对外可见"本身就是风险：错误会直接变成客户投诉。
  },
  // 破坏性的生产数据操作：彻底禁止，永远不可申请审批。
  deleteProductionUsers: {
    decision: "deny",
    reason: "Destructive production-data actions are forbidden.",
    // deny 与 require_approval 的本质区别：
    //   require_approval → 风险可以被人兜住，等一个"是"
    //   deny             → 风险无人能兜住，不存在"是"
    // 删生产用户没有任何合法的单次执行场景，
    // 它甚至不该出现在审批队列里浪费时间。
    // 注意纵深防御：tools.ts 里这个工具连实现都没有，
    // 即使本表的判定被绕过，也没有任何代码能真的删数据。
  },
};

/**
 * 评估一个工具的确定性策略。
 *
 * 默认拒绝（fail closed）：没有策略的工具被 deny，而不是放行。
 * 一个被人忘记分类的新工具，永远不可能悄悄变成可自动执行。
 */
export function evaluatePolicy(toolName: ToolName): PolicyResult {
  // 参数类型是 ToolName（四个字符串字面量的联合），
  // 所以合法输入一定能在表里查到——除非数据绕过了类型系统。
  const policy = TOOL_POLICIES[toolName];
  // 按当前静态类型，这个分支通常不会发生；保留运行时兜底，是因为真实系统
  // 可能收到旧数据、外部输入，或未来通过非 TypeScript 边界调用这里。
  //
  // "编译期保证 + 运行期兜底"双保险的理由：
  //   TS 类型只在编译时存在。一旦数据来自 JSON 文件、HTTP 请求、
  //   旧版本代码写入的存储，类型标注就只是"美好的假设"。
  //   安全关键路径永远再加一道运行时检查。
  if (!policy) {
    return {
      decision: "deny" satisfies PolicyDecision,
      // satisfies 运算符（TS 4.9+）：
      //   检查左边的值符合右边的类型，但不像 as 那样"强制断言"。
      //   写 "deny" satisfies PolicyDecision 的效果是——
      //   编译器立刻验证 "deny" 确实是 PolicyDecision 的合法值。
      //   如果哪天枚举改名（比如 "forbidden"），这里会编译报错提醒。
      //   比 `as PolicyDecision` 安全：as 是"闭眼相信"，satisfies 是"当场验证"。
      reason: `No policy is defined for "${toolName}". Denying by default.`,
      // 错误消息里带上工具名，方便排查是哪个工具漏配了策略。
    };
  }
  return policy;
  // 查到就直接返回。整个函数没有任何 I/O、随机数、时间、模型调用——
  // 这就是"确定性"的具体形态：
  //   同样的输入，任何时刻、任何进程，永远同样的输出。
  // 这让它可以被无限次重放测试（见 tests/runTests.ts 第 1-4 个用例）。
}

// ============================================================
//  本文件小结：为什么策略不交给模型
// ============================================================
//
// 模型擅长"理解请求、挑出合理工具"，但它是权限判定的错误场所：
//
// 1. prompt 不是执法边界。
//    "退款前必须征求批准"只是模型可以"被劝退"或干脆搞错的一句话。
// 2. 权限必须是确定性、可审计、可测试的应用关注点。
//    代码表三者兼备；prompt 里的句子三者皆无。
// 3. 策略变化要有 diff。
//    把 refundOrder 从 require_approval 改成 deny，
//    在这里是清晰的一行 git diff；在 prompt 里是谁也说不清的一句话。
//
// 判断清单：把你的每个工具套进这三问——
//   - 只读无副作用？ → auto_execute
//   - 有副作用但人能兜底？ → require_approval
//   - 破坏性/不可兜底？ → deny
// ============================================================
