// Tool use: the LLM decides which of your functions to call, with what args.
// You run them. You hand the results back. It replies. See README for the full picture.

import "dotenv/config";
import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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
  const order = ORDERS[orderId];
  if (!order) return `No order found with ID ${orderId}`;
  return JSON.stringify(order);
}

function checkInventory(productName: string): string {
  const item = INVENTORY[productName];
  if (!item) return `Product "${productName}" not found in inventory`;
  return JSON.stringify(item);
}

function getCustomerProfile(customerId: string): string {
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
  {
    type: "function",
    function: {
      name: "get_order_status",
      description: "Look up the current status of a customer order by order ID",
      parameters: {
        type: "object",
        properties: {
          order_id: {
            type: "string",
            description: "The order ID, format: ORD-XXX — e.g. ORD-001",
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
      description: "Check the current stock level for a product by name",
      parameters: {
        type: "object",
        properties: {
          product_name: {
            type: "string",
            description: "Exact product name as stored in the system — e.g. 'Wireless Headphones'",
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
      description: "Retrieve a customer's profile: name, email, and support tier",
      parameters: {
        type: "object",
        properties: {
          customer_id: {
            type: "string",
            description: "The customer ID, format: CUST-XX — e.g. CUST-42",
          },
        },
        required: ["customer_id"],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Dispatcher — routes the model's tool request to the right function.
// This is the security boundary. The model can't run code — only request it.
// Auth checks, rate limits, and input validation belong here.
// ---------------------------------------------------------------------------

function executeTool(name: string, args: Record<string, string>): string {
  switch (name) {
    case "get_order_status":    return getOrderStatus(args.order_id);
    case "check_inventory":     return checkInventory(args.product_name);
    case "get_customer_profile": return getCustomerProfile(args.customer_id);
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
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content:
        "You are a helpful order support assistant. Always use the available tools to look up real data before responding. Never guess order statuses, stock levels, or customer details.",
    },
    { role: "user", content: userMessage },
  ];

  console.log(`\nUser: ${userMessage}\n`);

  while (true) {
    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
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
      console.log(`Model requested ${toolCalls.length} tool call(s):`);

      for (const call of toolCalls) {
        // arguments arrives as a JSON string — always parse it.
        const args = JSON.parse(call.function.arguments) as Record<string, string>;
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
  // 1. Single tool call — model calls get_order_status once and replies
  const reply1 = await runWithTools("What's the status of order ORD-002?");
  console.log(`Assistant: ${reply1}\n`);
  console.log("─".repeat(60));

  // 2. Parallel tool calls — model calls get_order_status + check_inventory
  //    in the same round because both lookups are independent
  const reply2 = await runWithTools(
    "I'm customer CUST-42. I want to reorder the Wireless Headphones from ORD-001. Are they in stock?"
  );
  console.log(`Assistant: ${reply2}\n`);
  console.log("─".repeat(60));

  // 3. Two tools, combined response — model pulls profile + order together
  const reply3 = await runWithTools(
    "Customer CUST-17 is asking about order ORD-003. Can you pull up their profile and the order details?"
  );
  console.log(`Assistant: ${reply3}\n`);
}

main().catch(console.error);
