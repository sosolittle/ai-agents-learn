// ============================================================
//  第二章：tool-use（工具调用）
//
//  学习目标：
//  1. 理解“模型决定调用什么工具，代码负责真正执行工具”
//  2. 看懂 tools 数组如何描述可用函数和参数 schema
//  3. 学会把 tool_calls 的参数解析后交给 dispatcher
//  4. 理解为什么工具调用需要循环，而不是只调用一次模型
//
//  这一章的核心结论：
//  LLM 不应该直接访问数据库、文件系统或外部服务。
//  它只能“请求调用工具”；是否执行、如何校验、返回什么结果，
//  都由你的 TypeScript 代码控制。
// ============================================================

// Tool use: the LLM decides which of your functions to call, with what args.
// You run them. You hand the results back. It replies. See README for the full picture.

import "dotenv/config";
import OpenAI from "openai";
import client from "./src/openai-charles-client";

// const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

// 这一章只用 OpenAI 客户端，因为重点是 function calling / tool use 模式。

// ---------------------------------------------------------------------------
// Mock backend — in a real app these would hit a DB, Redis, or internal API.
// The LLM never calls these directly. You call them on its behalf.
// ---------------------------------------------------------------------------

const ORDERS: Record<string, { status: string; item: string; quantity: number }> = {
  "ORD-001": { status: "shipped",    item: "Wireless Headphones", quantity: 1 },
  "ORD-002": { status: "processing", item: "Mechanical Keyboard",  quantity: 2 },
  "ORD-003": { status: "delivered",  item: "USB-C Hub",            quantity: 1 },
};

const INVENTORY: Record<string, { stock: number; sku: string }> = {
  "Wireless Headphones": { stock: 14, sku: "WH-100" },
  "Mechanical Keyboard": { stock: 0,  sku: "MK-200" }, // intentionally out of stock
  "USB-C Hub":           { stock: 32, sku: "UC-300" },
};

const CUSTOMERS: Record<string, { name: string; email: string; tier: "standard" | "premium" }> = {
  "CUST-42": { name: "Alex Rivera", email: "alex@example.com", tier: "premium"  },
  "CUST-17": { name: "Sam Chen",    email: "sam@example.com",  tier: "standard" },
};

function getOrderStatus(orderId: string): string {
  // 模拟“查订单状态”的后端函数。
  // 注意：模型不会直接执行这个函数，executeTool 才会执行。
  const order = ORDERS[orderId];
  if (!order) return `No order found with ID ${orderId}`;
  return JSON.stringify(order);
}

function checkInventory(productName: string): string {
  // 模拟“查库存”的后端函数。返回字符串是为了直接放进 tool 消息里。
  const item = INVENTORY[productName];
  if (!item) return `Product "${productName}" not found in inventory`;
  return JSON.stringify(item);
}

function getCustomerProfile(customerId: string): string {
  // 模拟“查客户资料”。真实业务里这里会有鉴权和隐私控制。
  const customer = CUSTOMERS[customerId];
  if (!customer) return `No customer found with ID ${customerId}`;
  return JSON.stringify(customer);
}

// ---------------------------------------------------------------------------
// Tool definitions — the "menu" you hand the LLM.
// The description tells it WHEN to use the tool.
// The parameter descriptions tell it HOW to fill in the arguments.
// Vague descriptions = wrong tool called. Missing format hints = bad args passed.
// ---------------------------------------------------------------------------

const tools: OpenAI.Chat.ChatCompletionTool[] = [
  // tools 是给模型看的“工具菜单”。
  // 里面的 name/description/parameters 会影响模型是否选对工具、参数是否填对。
  {
    type: "function",
    function: {
      name: "get_order_status",
      description: "根据订单号查询客户订单的当前状态",
      parameters: {
        type: "object",
        properties: {
          order_id: {
            type: "string",
            description: "订单号，格式为 ORD-XXX，例如 ORD-001",
          },
        },
        required: ["order_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_inventory",
      description: "根据商品名称查询当前库存数量",
      parameters: {
        type: "object",
        properties: {
          product_name: {
            type: "string",
            description: "系统中保存的准确商品名称，例如“Wireless Headphones”",
          },
        },
        required: ["product_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_customer_profile",
      description: "查询客户资料，包括姓名、邮箱和支持等级",
      parameters: {
        type: "object",
        properties: {
          customer_id: {
            type: "string",
            description: "客户编号，格式为 CUST-XX，例如 CUST-42",
          },
        },
        required: ["customer_id"],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// parseToolArgs — safely parses the JSON string the model sends as arguments.
// The model always sends arguments as a JSON string, never a plain object.
// If the model sends malformed JSON (rare but possible), return empty rather
// than crashing the loop — executeTool will surface a clear error instead.
// ---------------------------------------------------------------------------

function parseToolArgs(raw: string): Record<string, string> {
  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Dispatcher — routes the model's tool request to the right function.
// This is the security boundary. The model can't run code — only request it.
// Auth checks, rate limits, and input validation belong here.
// ---------------------------------------------------------------------------

function executeTool(name: string, args: Record<string, string>): string {
  // dispatcher 是非常重要的安全边界：
  // 模型给出的是“请求”，这里的 switch 才决定实际允许调用哪些函数。
  switch (name) {
    case "get_order_status":
      if (!args.order_id) return "Missing required argument: order_id";
      return getOrderStatus(args.order_id);
    case "check_inventory":
      if (!args.product_name) return "Missing required argument: product_name";
      return checkInventory(args.product_name);
    case "get_customer_profile":
      if (!args.customer_id) return "Missing required argument: customer_id";
      return getCustomerProfile(args.customer_id);
    default:
      // The model can hallucinate a tool name — always handle the unknown case.
      return `Unknown tool: "${name}"`;
  }
}

// ---------------------------------------------------------------------------
// The tool-use loop — loop until finish_reason === "stop".
//
// One API call is not enough. After seeing tool results, the model may ask
// for more tools before it's ready to reply. You keep looping until it stops.
// The model can also call multiple tools in one round (parallel fetches) —
// tool_calls is an array, always iterate it, never assume length === 1.
//
// Full message flow:
//   → [system, user]
//   ← assistant { tool_calls: [...] }   finish_reason: "tool_calls"
//   → [system, user, assistant, tool(result), tool(result), ...]
//   ← assistant { content: "..." }      finish_reason: "stop"
// ---------------------------------------------------------------------------

async function runWithTools(userMessage: string): Promise<string> {
  // runWithTools 是完整工具调用循环。
  // 它会不断把“模型决定 -> 工具结果 -> 模型继续决定”串起来，
  // 直到模型给出最终自然语言回答。
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content:
        "你是一名乐于助人的订单客服助手。回答前必须使用可用工具查询真实数据，绝不能猜测订单状态、库存数量或客户资料。",
    },
    { role: "user", content: userMessage },
  ];

  console.log(`\n用户：${userMessage}\n`);

  while (true) {
    const response = await client.chat.completions.create({
      model: model,
      messages,
      tools,
      // "auto" = model decides whether to call a tool or reply directly.
      // Other values: "required" (must call a tool), "none" (no tools),
      // or { type: "function", function: { name: "..." } } to force one.
      tool_choice: "auto",
    });

    const choice = response.choices[0];
    messages.push(choice.message); // always append — model needs its own history

    if (choice.finish_reason === "stop") {
      return choice.message.content ?? "";
    }

    if (choice.finish_reason === "tool_calls") {
      const toolCalls = choice.message.tool_calls ?? [];
      console.log(`模型请求调用 ${toolCalls.length} 个工具：`);

      for (const call of toolCalls) {
        // 一个 assistant message 里可能有多个 tool call。
        // 例如用户同时问订单和库存时，模型可以一次请求两个独立查询。
        // arguments arrives as a JSON string — always parse it.
        const args = parseToolArgs(call.function.arguments);
        console.log(`  → ${call.function.name}(${JSON.stringify(args)})`);

        const result = executeTool(call.function.name, args);
        console.log(`  ← ${result}`);

        // tool_call_id must match the model's request — this is how it maps
        // results back to calls when multiple tools run in one round.
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: result,
        });
      }

      console.log();
    }
  }
}

// ---------------------------------------------------------------------------
// Demo — three queries showing single call, parallel calls, and combined lookup
// ---------------------------------------------------------------------------

async function main() {
  // 三个 demo 从简单到复杂：
  // 1. 单工具调用
  // 2. 多工具并行请求
  // 3. 多个数据源合成回答
  // 1. Single tool call — model calls get_order_status once and replies
  const reply1 = await runWithTools("订单 ORD-002 当前是什么状态？");
  console.log(`助手：${reply1}\n`);
  console.log("─".repeat(60));

  // 2. Parallel tool calls — model calls get_order_status + check_inventory
  //    in the same round because both lookups are independent
  const reply2 = await runWithTools(
    "我是客户 CUST-42，想再次购买订单 ORD-001 中的 Wireless Headphones。现在有库存吗？"
  );
  console.log(`助手：${reply2}\n`);
  console.log("─".repeat(60));

  // 3. Two tools, combined response — model pulls profile + order together
  const reply3 = await runWithTools(
    "客户 CUST-17 正在询问订单 ORD-003。请查询该客户的资料和订单详情。"
  );
  console.log(`助手：${reply3}\n`);
}

main().catch(console.error);
