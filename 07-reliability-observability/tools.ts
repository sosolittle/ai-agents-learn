// ============================================================
//  第七章配套文件：mock 工具层（后厨）
//
//  🏠 生活化比喻：
//  index.ts 的 agent 循环是前台服务员：接单、传达给后厨、上菜；
//  本文件是后厨。其中 getOrderStatus 被故意装了一根「跳闸的
//  保险丝」——第一次调用必失败（模拟数据库抖了一下），
//  重试一次就好。checkInventory 一切正常，作对照组。
//  finalAnswer 是收工单：一交单，本轮服务结束。
//
//  后厨的两个职业操守：
//   ① 出菜要么成功、要么明确报错——绝不上「半生不熟」的菜
//     （工具返回结构化的成功/失败结果，而不是抛异常或裸值）；
//   ② 报错必须说清「这道菜还能不能重做」——
//     临时故障（超时、503）retryable: true，值得再试；
//     永久错误（订单不存在、参数不合法）retryable: false，
//     再试一万次结果也一样，别浪费重试和迭代。
//
//  学习目标：
//  1. 理解工具函数应该返回结构化成功/失败结果
//  2. 区分 retryable 临时错误和不可重试的永久错误
//  3. 看懂 dispatcher 如何成为模型与真实后端之间的安全边界
//
//  核心结论：
//  工具的错误也要是「数据」而不是「事故」：
//  带 ok / error / retryable 三个字段的结果对象，
//  让上层（index.ts 的重试逻辑）能据此编程决策。
// ============================================================

// Mock backend tools for the reliability demo.
//
// These stand in for whatever your real backend does — a database query, an
// HTTP call, a cache lookup. The point of the demo is the agent loop around
// them, not the tools themselves.
// （这些工具替身代表你真实后端里的数据库查询 / HTTP 调用 / 缓存读取。
//   demo 的主角是围着我们转的那个循环，不是工具本身。）
//
// getOrderStatus is rigged to fail on its first call so we can show what a
// transient backend error looks like from the agent's perspective, and how a
// retry recovers.

// TS 语法：export = 「导出，允许其他文件 import」。
// 不加 export 的声明只在本文件可见（模块作用域）。

export interface ToolResult {
  // 成功分支。ok 的类型不是 boolean，而是字面量 true——
  // 它只可能是 true，作用是当「标签」用（见下面 ToolOutcome）。
  ok: true;
  // 成功时带回的数据。unknown = 任意类型都行，
  // 每个工具的 value 形状各不相同（订单状态/库存/最终答案）。
  value: unknown;
}

export interface ToolError {
  // 失败分支。ok: false 同样是字面量类型。
  ok: false;
  error: string;
  // Whether retrying might help. Transient errors (timeouts, 503s) — yes.
  // Permanent errors (404, invalid input) — no. The agent shouldn't burn
  // iterations retrying a tool that will fail the same way every time.
  // 重试有没有用？临时错误（超时、503）有用；永久错误（404、
  // 参数错）没用——不该为「每次都会同样失败的工具」烧掉重试次数。
  retryable: boolean;
}

// TS 语法：可辨识联合（discriminated union）——
// ToolOutcome 要么是 ToolResult 要么是 ToolError，靠 ok 字段区分。
// 好处：上层代码 if (outcome.ok) 之后，TS 自动知道走的是成功分支
// （有 value、没有 error/retryable），else 分支反之——
// 类型收窄替你省掉一堆强制转换和猜字段。
// index.ts 里的 ParsedToolArgs 用的是同一招。
export type ToolOutcome = ToolResult | ToolError;

// Per-tool state. In a real system this would be the database / HTTP client.
// Here it's a counter so we can deterministically fail the first call.
// 模块级可变状态：整个模块共享这一个计数器（模块里 let 的变量
// 在所有 import 方之间是同一个）。真实系统里这块状态是数据库连接
// 或 HTTP 客户端；这里用计数器让「第一次必失败」变得确定可复现——
// 每次运行 demo 都能看到同样的失败-重试轨迹。
let getOrderStatusAttempts = 0;

export function resetToolState(): void {
  // 把计数器拨回 0。demo 每次启动先调用它，保证行为可复现；
  // 测试里也能用它把「第一次失败」的机关重新上膛。
  getOrderStatusAttempts = 0;
}

export async function getOrderStatus(orderId: string): Promise<ToolOutcome> {
  // 这个工具故意第一次失败，用来演示 index.ts 里的 retry 逻辑。
  // 因为失败是确定性的，所以学习时每次运行都能看到同样的轨迹。
  getOrderStatusAttempts++;

  // First call fails with a transient error — the kind of thing you'd see
  // from a flaky database connection or an overloaded upstream service.
  // 第一次调用：临时故障（数据库连接抖动 / 上游过载的真实写照）。
  // retryable: true 告诉上层「值得再试一次」。
  if (getOrderStatusAttempts === 1) {
    return { ok: false, error: "Temporary database timeout", retryable: true };
  }

  if (orderId === "ORD-001") {
    return {
      ok: true,
      value: { status: "shipped", trackingNumber: "TRK-123", carrier: "UPS" },
    };
  }

  // Permanent error — retrying won't help, the order genuinely doesn't exist.
  // 永久错误：订单真的不存在，重试无意义——直接告诉上层「别试了」。
  // 对比上面：同样是 { ok: false }，retryable 一个 true 一个 false，
  // 上层的处理路径就此分岔。这就是「错误也要是数据」。
  return { ok: false, error: `Order not found: ${orderId}`, retryable: false };
}

export async function checkInventory(productName: string): Promise<ToolOutcome> {
  // 库存工具没有故意失败，方便和 getOrderStatus 的重试行为做对比。
  // TS 语法：Record<string, number> = 键是商品名、值是库存数的字典。
  const stock: Record<string, number> = {
    "Wireless Headphones": 14,
    "USB-C Cable": 0,
  };
  // 字典查不到的键返回 undefined（不是报错），所以能这样判断。
  const count = stock[productName];
  if (count === undefined) {
    return { ok: false, error: `Unknown product: ${productName}`, retryable: false };
  }
  return { ok: true, value: { product: productName, inStock: count > 0, units: count } };
}

// Terminal tool — calling this ends the run. Same pattern as 03-agent-loop:
// completion is an explicit decision the agent commits to, not just the
// absence of more tool calls.
// 终止工具：交收工单。和第三章 write_report、第四章 write_answer 同款——
// 「完成」是 agent 明确承诺的动作，不是「恰好不再调工具」。
export async function finalAnswer(content: string): Promise<ToolOutcome> {
  return { ok: true, value: { final: content } };
}

// Dispatcher. The model can only ask for a tool by name — the security
// boundary lives here. Unknown names get a clear error instead of crashing.
// 分发器（后厨领班）：模型只能「报菜名」，真正执行哪个函数由这里决定。
// 安全边界住在这一层——没登记的名字一律明确报错，绝不崩溃。
export async function runTool(
  name: string,
  args: Record<string, unknown>
): Promise<ToolOutcome> {
  // dispatcher 再次做参数类型检查。
  // 即使工具 schema 写了 required，模型输出仍然可能缺字段或类型不对。
  //
  // ⚠️ 为什么明明是 TS 还要手写 typeof 检查？因为 TS 的类型只在
  // 编译时存在，运行时全部被擦掉——args 是模型生成的 JSON 解析来的，
  // 它里面到底是什么，编译器根本管不着。凡是「外部数据进系统」的
  // 边界（模型输出、HTTP 响应、文件内容），都要在运行时重新验证。
  switch (name) {
    case "getOrderStatus":
      if (typeof args.orderId !== "string") {
        return { ok: false, error: "orderId must be a string", retryable: false };
      }
      // 到这里 TS 已确认 orderId 是 string，可以安全传给函数。
      return getOrderStatus(args.orderId);

    case "checkInventory":
      if (typeof args.productName !== "string") {
        return { ok: false, error: "productName must be a string", retryable: false };
      }
      return checkInventory(args.productName);

    case "finalAnswer":
      if (typeof args.content !== "string") {
        return { ok: false, error: "content must be a string", retryable: false };
      }
      return finalAnswer(args.content);

    default:
      // default 兜底不可省：模型可能幻觉出不存在的工具名。
      return { ok: false, error: `Unknown tool: ${name}`, retryable: false };
  }
}

export const ALLOWED_TOOLS = new Set(["getOrderStatus", "checkInventory", "finalAnswer"]);
// allow-list 给 agent loop 使用：模型只能请求这三个工具。
// 用 Set 存：has() 查询极快，且语义就是「在不在名单上」。
// index.ts 的 validateToolName 拿它做第一道闸门。
