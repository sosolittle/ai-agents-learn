// ============================================================
//  第十一章：业务工具（tools.ts）
//  被审批工作流保护的业务能力（本章全部为 mock）
//
//  学习目标：
//  1. 工具只实现业务动作，不自行决定"是否需要审批"
//     —— 那是 policy.ts 的事，工具对此一无所知
//  2. 在真正调用工具前，再次用判别联合 Schema 校验参数（纵深防御）
//  3. 用"无实现的危险工具"演示纵深防御的最后一层
//  4. 用穷尽 switch + never 检查，保证新增工具时不会漏写分发逻辑
//
//  本文件在整个章节中的角色：
//  它是"被治理的业务层"。审批流程（service/executor）负责"能不能做"，
//  本文件负责"具体怎么做"。两层解耦后：
//  加一个新工具 = 加一个函数 + 一条 Schema 分支 + 一条策略，
//  治理框架一行都不用改。
// ============================================================

import { ActionProposalSchema, type ToolName } from "./types.js";
// 工具层也要用提案 Schema 做参数复验——
// 注意这是同一个 Schema 的第三次使用（agent 边界、审批边界、执行边界），
// "一份契约，多处把守"正是 Schema 集中定义的好处。

// Mock 业务数据和工具。这里没有任何真实的退款、取消或数据库变更——
// 每个工具都返回带 `mock: true` 标记的类型化结果。
// 重点是被工具包围的审批工作流，而不是集成本身。
//
// 为什么 mock 而不是接真支付接口？
//   1. 学习目标是控制流（提案→策略→审批→执行→审计），不是支付对接；
//   2. mock 让测试可以无限重跑，不产生真实扣款；
//   3. 每个结果都标 mock: true，肉眼就能确认"这是演示数据"。
//   换成真实现时，只改本文件的函数体，治理层不变。

export interface Order {
  // 用 interface 而不是 Zod：Order 只在本模块内部使用，
  // 不跨不可信边界（理由见 types.ts 里 PolicyResult 的注释）。
  orderId: string;
  customerId: string;
  totalAmount: number;
  // 订单总额（整数欧元）。refundOrder 用它检查"退款不超总额"。
  // 注意 README 的 Production notes 提醒：真实货币请用整数分
  // 或十进制类型，浮点数直接算钱会出精度问题。
  currency: "EUR";
  // 字面量类型 "EUR"：本演示只有欧元。
  status: "delivered" | "in_transit" | "cancelled";
  // 订单状态的联合类型（这又是"判别"思想在普通对象上的应用）。
}

// 演示用的唯一一笔订单。
const MOCK_ORDERS: Record<string, Order> = {
  // Record<string, Order>：订单号 → 订单对象的查找表。
  // 真实系统里这是数据库查询；这里一张哈希表就够演示了。
  "ORD-001": {
    orderId: "ORD-001",
    customerId: "CUS-104",
    totalAmount: 79,
    // 79 欧元的订单，演示请求正好是"退 79"，
    // 人工编辑后改成"退 49"（部分退款）——两个数字都合法，
    // 是故意设计的对照。
    currency: "EUR",
    status: "delivered",
    // "已送达"状态是退款请求的合理前提：
    // 包裹到了但损坏，所以退部分款。演示故事线是自洽的。
  },
};

export interface OrderStatusResult extends Order {
  // extends Order：继承订单的全部字段，再加一个标记字段。
  mock: true;
  // 字面量类型 true（不是 boolean）：
  // 这个字段的值永远、只能是 true。它是一个"编译期常量标记"，
  // 让读到这个类型的代码无法忽略"这是 mock 数据"。
}

export interface RefundResult {
  refundId: string;
  // 退款单号（REF-001...），由 executor 分配，保证确定且可持久化。
  orderId: string;
  amount: number;
  currency: "EUR";
  status: "processed";
  // 字面量 "processed"：mock 工具永远成功，
  // 失败路径（抛异常）和成功路径（带状态的结果）类型上就分开了。
  mock: true;
}

export interface CancellationResult {
  cancellationId: string;
  customerId: string;
  status: "cancelled";
  mock: true;
}

function getOrder(orderId: string): Order {
  // 即使 Schema 已验证 ID 格式，也仍需验证业务实体是否存在。
  // "ORD-999 格式正确"和"ORD-999 是真实订单"是两件不同的事。
  //
  // 这是校验分层的重要一课：
  //   Schema 层  → 形状约束（"像不像订单号"）——无需业务数据
  //   业务层     → 存在性约束（"是不是真订单"）——需要查数据
  // 把存在性检查塞进 Zod 自定义校验器也能做，
  // 但那会让 Schema 变成有副作用的代码（要查库），
  // 失去"纯数据形状描述"的定位。分层更干净。
  const order = MOCK_ORDERS[orderId];
  if (!order) throw new Error(`Unknown order: ${orderId}`);
  // 抛错会一路冒泡到 executor → approvalService → CLI，
  // 最终审批单停在 approved（不是 executed），不会谎报成功。
  return order;
}

/** 只读订单查询。策略下自动执行。 */
export function getOrderStatus(args: { orderId: string }): OrderStatusResult {
  // 参数类型是内联对象类型（不引用 Zod）——
  // 外层 runTool 已经复验过，函数内可以直接信任参数。
  return { ...getOrder(args.orderId), mock: true };
  // 展开运算符 ... 的两重作用：
  //   1. 复制订单的所有字段到新对象（浅拷贝）
  //   2. 和 { mock: true } 合并成 OrderStatusResult
  // 不直接返回 MOCK_ORDERS[orderId] 的引用：
  // 返回副本后，调用方改它不会污染 MOCK_ORDERS 数据源。
}

/** Mock 退款。refundId 由 executor 提供，因此是确定性的且已持久化。 */
export function refundOrder(
  args: { orderId: string; amount: number; currency: "EUR"; reason: string },
  refundId: string
): RefundResult {
  // 第二个参数 refundId 是本函数设计的点睛之笔：
  // 退款单号不是工具内部随机生成的，而是 executor 分配的
  // 确定性顺序 ID。这样同一个执行重放时结果是确定的，
  // 也让"业务结果"和"执行记录"从编号上就能对应（EXE-001 → REF-001）。
  const order = getOrder(args.orderId);
  // Zod 负责 amount > 0；工具层负责 amount <= 订单总额。
  // 前者是输入形状约束，后者依赖业务数据，应该靠近业务动作检查。
  //
  // 为什么不全放进 Schema？
  //   "金额 ≤ 79"要查订单总额才知道——Schema 是纯形状描述，
  //   不该背数据库查询。校验放对层级，代码才各自简单。
  if (args.amount > order.totalAmount) {
    throw new Error(
      `Refund amount ${args.amount} exceeds order total ${order.totalAmount}.`
    );
    // "退 100 欧但订单只有 79"是格式合法但业务非法的输入，
    // 只能在这里（有业务数据的地方）拦下。
  }
  return {
    refundId,
    orderId: args.orderId,
    amount: args.amount,
    currency: args.currency,
    status: "processed",
    mock: true,
  };
}

/** Mock 订阅取消。策略下需要审批。 */
export function cancelSubscription(
  args: { customerId: string; reason: string },
  cancellationId: string
): CancellationResult {
  // 与退款同构：executor 提供 cancellationId（CAN-001...），
  // 工具只负责按参数产出结果。
  return {
    cancellationId,
    customerId: args.customerId,
    status: "cancelled",
    mock: true,
  };
}

/**
 * 禁止的工具。它刻意没有可用的实现：即使某个 bug 或
 * 一次错误调用以某种方式绕过了策略层，这里也没有任何
 * 能删掉东西的代码。这是纵深防御——策略拒绝它，
 * executor 拒绝它，工具本身也会抛错。
 */
export function deleteProductionUsers(): never {
  // 返回类型 never 是 TypeScript 里很特别的一个类型：
  // "这个函数正常返回是不可能的"——要么抛异常，要么死循环。
  // 读到 never 返回类型的开发者会立刻明白：
  // "没有任何成功路径"，连 TypeScript 都不允许你使用它的返回值。
  throw new Error(
    "deleteProductionUsers is a forbidden action with no executable implementation. " +
      "It is denied by policy and must never reach an executor."
  );
  // 纵深防御的第三层（也是最后一层）：
  //   第 1 层：policy.ts 查表 → deny，提案直接出局
  //   第 2 层：executor.ts 边界 → 再查一次 policy，deny 就抛错
  //   第 3 层：本函数根本"没有身体"——即使前两层都被绕过，
  //            唯一能执行的代码路径是 throw
  // "危险操作最安全的实现是不存在实现。"
}

// 每个工具结果 ID 的前缀，退款是 REF-001、REF-002 等。
export const RESULT_ID_PREFIX: Record<ToolName, string> = {
  // 又是 Record<ToolName, ...> 强制穷尽（见 policy.ts 的说明）：
  // 新增工具忘了配前缀，编译报错。
  // LKP = lookup（查询结果），REF = refund，CAN = cancel，DEL = delete。
  getOrderStatus: "LKP",
  refundOrder: "REF",
  cancelSubscription: "CAN",
  deleteProductionUsers: "DEL",
};

/**
 * 把一个已验证的动作分发给对应的 mock 工具，返回类型化结果。
 *
 * 纵深防御：参数在调用前的最后一刻，再次用判别联合校验，
 * 所以参数已经"漂移变形"的记录永远到不了工具。
 * `resultId` 是工具盖在结果上的确定性 ID（例如 refundId）。
 */
export function runTool(
  toolName: ToolName,
  args: Record<string, unknown>,
  resultId: string
): Record<string, unknown> {
  // 三个参数的视角值得注意：
  //   toolName → 已经是收窄的联合类型
  //   args     → 还是开放的 Record<string, unknown>！
  //             因为它可能来自磁盘上的审批单（编辑过、躺了很久），
  //             本函数的职责之一就是把它在"最后一刻"重新收窄。
  //   resultId → executor 算好的确定性结果 ID
  const proposal = ActionProposalSchema.parse({
    toolName,
    arguments: args,
    // `reason` 是 Schema 必需的，但与执行无关；提供一个
    // 占位值让校验专注于参数。
    reason: "revalidated before execution",
  });
  // 这里重建完整 proposal 只是为了复用同一个判别联合 Schema。
  // 任何从磁盘读取或人工编辑后变形的参数，都会在触达工具前被拦截。
  //
  // 为什么"明明上层都验过了"还要再验？
  //   因为调用链的每一环都可能是"最后一环"：
  //   executor 可能被直接调用（测试里就这么干），
  //   数据可能绕过 service 直接落盘（测试里手工写过）。
  //   每个能触达工具的入口都自证清白，才叫纵深防御。
  //
  // 校验通过后，proposal 的类型被 Zod 收窄成具体分支，
  // 下面每个 case 里 proposal.arguments 都有确切的字段——
  // 这就是判别联合 + parse 的组合拳：运行时校验和编译期收窄一次完成。

  switch (proposal.toolName) {
    // switch 判别的对象是判别字段 toolName。
    // 在每个 case 里，TypeScript 自动把 proposal 的类型
    // 收窄到对应分支（比如 case "refundOrder" 里
    // proposal.arguments 一定是 { orderId, amount, currency, reason }）。
    // 这是判别联合和 switch 的天作之合。
    case "getOrderStatus":
      return { ...getOrderStatus(proposal.arguments) };
      // 展开成新对象，保持"返回副本不返回内部引用"的习惯。
    case "refundOrder":
      return { ...refundOrder(proposal.arguments, resultId) };
    case "cancelSubscription":
      return { ...cancelSubscription(proposal.arguments, resultId) };
    case "deleteProductionUsers":
      // 实际上不可达——策略早在到这里之前就 deny 了——
      // 但万一被调用，工具本身仍然会拒绝。
      return deleteProductionUsers();
      // 返回 never 的函数可以直接出现在 return 位置。
      // 真执行到这行只会抛错，"return"只是语法占位。
    default: {
      // 穷尽性检查：如果联合类型新增工具但这里没有 case，
      // proposal 将不再能赋给 never，typecheck 会提醒补充分支。
      const exhaustive: never = proposal;
      // 这是 TypeScript 穷尽检查的标准写法：
      //   如果 switch 覆盖了联合的所有成员，
      //   走到 default 时 proposal 的类型只剩 never（什么都不可能是），
      //   `const exhaustive: never = proposal` 编译通过。
      //   但如果漏了一个 case（比如新增了工具 "escalateTicket"），
      //   走到 default 时 proposal 还可能是那个类型，
      //   never 赋值编译报错——提醒你"有分支没写"。
      // 比 default: throw 更好：错误在编译期暴露，不是运行时撞上才炸。
      throw new Error(`Unhandled tool: ${JSON.stringify(exhaustive)}`);
      // 这个 throw 主要是给"绕过类型系统的外部数据"兜底。
    }
  }
}

// ============================================================
//  本文件小结：工具层的三条纪律
// ============================================================
//
// 1. 工具不知道自己的风险等级。
//    refundOrder 函数体里没有一行"我需要审批"——
//    风险分级是 policy 的职责，工具只是诚实地执行业务。
//
// 2. 形状校验在 Schema，业务校验在工具。
//    "amount > 0"（纯形状）vs "amount ≤ 订单总额"（要查数据）。
//
// 3. 危险操作不给实现。
//    deleteProductionUsers 的函数体就是一句 throw——
//    最不可绕过的防线是"想执行也没得执行"。
// ============================================================
