// ============================================================
//  第八章 tools：评测用 mock 工具（答案唯一的后厨）
//
//  🏠 生活化比喻：
//  评测要有标准答案，后厨的菜就得「每次炒出来一个味」：
//  数据是写死在代码里的两张小表格（订单表 + 库存表），
//  不连数据库、不联网、不会变。于是考卷才敢写死
//  「答案必须包含 TRK-789」——因为 ORD-001 的运单号
//  永远是 TRK-789。固定 mock = 评测可重复的前提。
//
//  学习目标：
//  1. 用固定数据让评测结果可重复
//  2. 通过 runTool 统一工具调用入口
//  3. 理解评测用工具不需要真实后端，也能验证 agent 决策路径
// ============================================================

// TS 语法：as const = 「冻结字面量」。
// 加了它，"shipped" 的类型不再是宽泛的 string，而是字面量 "shipped"；
// 数组也变成只读元组。好处：键和值都被编译器记死，写错键名会报错；
// 配合下面的 keyof typeof，查表访问还能拿到精确的值类型。
const orders = {
  "ORD-001": {
    status: "shipped",
    trackingNumber: "TRK-789",
    item: "Wireless Headphones",
  },
  "ORD-002": {
    status: "processing",
    // null 是「真的还没有」——正是第 3 题（不许编运单号）的数据基础。
    trackingNumber: null,
    item: "Mechanical Keyboard",
  },
} as const;

const inventory = {
  "Wireless Headphones": { inStock: true, quantity: 12 },
  "Mechanical Keyboard": { inStock: false, quantity: 0 },
} as const;

// 可辨识联合（同第七章 tools.ts）：ok 当标签区分成功/失败。
// 评测版没有 retryable 字段——本章不搞重试，错误直接上交判卷。
export type ToolOutcome =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

export function getOrderStatus(orderId: string): ToolOutcome {
  // 根据订单号返回固定订单数据。
  // 固定数据让 eval cases 能写明确期望，例如必须包含 TRK-789。
  //
  // TS 语法：orders[orderId as keyof typeof orders] 的拆解——
  //   typeof orders      「orders 这个对象的类型」（两张订单的表）
  //   keyof …            它的键的联合："ORD-001" | "ORD-002"
  //   orderId as …       把用户传来的 string 断言成这两种键之一
  // 查不到时（ORD-999）TS 层面以为有、运行时拿到 undefined，
  // 所下一行照旧做 !order 判断——断言只是「帮我查表」，不替运行时把关。
  const order = orders[orderId as keyof typeof orders];
  if (!order) return { ok: false, error: `Unknown order: ${orderId}` };
  // spread 拼对象：{ orderId, ...order } = 订单号 + 表里的三个字段，
  // 凑成一个自包含的结果（模型不用知道「键」是什么）。
  return { ok: true, value: { orderId, ...order } };
}

export function checkInventory(productName: string): ToolOutcome {
  // 根据商品名返回固定库存数据。
  const stock = inventory[productName as keyof typeof inventory];
  if (!stock) return { ok: false, error: `Unknown product: ${productName}` };
  return { ok: true, value: { productName, ...stock } };
}

export function runTool(name: string, args: Record<string, unknown>): ToolOutcome {
  // 所有工具都通过这个 dispatcher 执行。
  // 评测时可以检查 agent 是否调用了正确工具和正确参数。
  // 边界上的运行时检查（typeof + trim）同第七章：TS 类型在运行时
  // 被擦掉，模型给的参数必须现场重验。
  switch (name) {
    case "getOrderStatus":
      if (typeof args.orderId !== "string" || args.orderId.trim() === "") {
        return { ok: false, error: "Missing orderId" };
      }
      return getOrderStatus(args.orderId);

    case "checkInventory":
      if (typeof args.productName !== "string" || args.productName.trim() === "") {
        return { ok: false, error: "Missing productName" };
      }
      return checkInventory(args.productName);

    case "finalAnswer":
      if (typeof args.content !== "string" || args.content.trim() === "") {
        return { ok: false, error: "Missing content" };
      }
      return { ok: true, value: { content: args.content } };

    default:
      // 模型幻觉出没登记的工具名：明确报错，判卷时在 trace 里可见。
      return { ok: false, error: `Unknown tool: ${name}` };
  }
}
