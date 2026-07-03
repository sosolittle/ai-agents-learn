// ============================================================
//  第八章 tools：评测用 mock 工具
//
//  学习目标：
//  1. 用固定数据让评测结果可重复
//  2. 通过 runTool 统一工具调用入口
//  3. 理解评测用工具不需要真实后端，也能验证 agent 决策路径
// ============================================================

const orders = {
  "ORD-001": {
    status: "shipped",
    trackingNumber: "TRK-789",
    item: "Wireless Headphones",
  },
  "ORD-002": {
    status: "processing",
    trackingNumber: null,
    item: "Mechanical Keyboard",
  },
} as const;

const inventory = {
  "Wireless Headphones": { inStock: true, quantity: 12 },
  "Mechanical Keyboard": { inStock: false, quantity: 0 },
} as const;

export type ToolOutcome =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

export function getOrderStatus(orderId: string): ToolOutcome {
  // 根据订单号返回固定订单数据。
  // 固定数据让 eval cases 能写明确期望，例如必须包含 TRK-789。
  const order = orders[orderId as keyof typeof orders];
  if (!order) return { ok: false, error: `Unknown order: ${orderId}` };
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
      return { ok: false, error: `Unknown tool: ${name}` };
  }
}
