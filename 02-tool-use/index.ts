import "dotenv/config"
import OpenAI from "openai";
import client from "./src/openai-charles-client"
import * as child_process from "node:child_process";

const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

// type OrderStatus = "processing" | "shipped" | "delivered";
//
// type Order = {
//     status: OrderStatus;
//     item: string;
//     quantity: number;
// };
//
// const ORDERS: Record<string, Order> = {
//     "ORD-001": {
//         status: "shipped",
//         item: "Wireless Headphones",
//         quantity: 1,
//     },
// };

type OrderStatus = "processing" | "shipped" | "delivered"

type Order = {
    status: OrderStatus,
    item: string,
    quantity: number
}

const ORDERS: Record<string, Order> = {
    "ORD-001": {status: "shipped", item: "Wireless Headphones", quantity: 1},
    "ORD-002": {status: "processing", item: "Mechanical Keyboard", quantity: 2},
    "ORD-003": {status: "delivered", item: "USB-C Hub", quantity: 1},
}

const INVENTORY: Record<string, { stock: number; sku: string }> = {
    "Wireless Headphones": {stock: 14, sku: "WH-100"},
    "Mechanical Keyboard": {stock: 0, sku: "MK-200"},
    "USB-C Hub": {stock: 32, sku: "UC-300"},
};

const CUSTOMERS: Record<string, { name: string; email: string; tier: "standard" | "premium" }> = {
    "CUST-42": {name: "Alex Rivera", email: "alex@example.com", tier: "premium"},
    "CUST-17": {name: "Sam Chen", email: "sam@example.com", tier: "standard"},
};

const tools: OpenAI.Chat.ChatCompletionTool[] = [
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
                        description: "订单号，格式为 ORD-XXX，例如 ORD-001"
                    }
                },
                required: ["order_id"]
            }
        }
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
                        description: "系统中保存的准确商品名称，例如“Wireless Headphones”"
                    }
                },
                required: ["product_name"]
            }
        }
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
                        description: "系统中保存的准确商品名称，例如“Wireless Headphones”"
                    }
                },
                required: ["customer_id"]
            }
        }
    }
]

function getOrderStatus(orderId: string): string {
    const order = ORDERS[orderId]
    if (!order) return `No order found with ID ${orderId}`;
    return JSON.stringify(order)
}

function checkInventory(productName: string): string {
    const item = INVENTORY[productName]
    if (!item) return `Product "${productName} not found in inventory"`
    return JSON.stringify(item)
}

function getCustomerProfile(customerId: string): string {
    const customer = CUSTOMERS[customerId]
    if (!customer) return `No customer found with ID ${customerId}`
    return JSON.stringify(customer)
}

function parseToolArgs(raw: string): Partial<Record<string, string>> {
    try {
        return JSON.parse(raw) as Partial<Record<string, string>>
    } catch (e) {
        return {}
    }
}

function executeTool(name: string, args: Partial<Record<string, string>>): string {
    switch (name) {
        case "get_order_status":
            if (!args.order_id) return "Missing required argument: order_id";
            return getOrderStatus(args.order_id)
        case "check_inventory":
            if (!args.product_name) return "Missing required argument: order_id";
            return checkInventory(args.product_name)
        case "get_customer_profile":
            if (!args.customer_id) return "Missing required argument: order_id";
            return getCustomerProfile(args.customer_id)
        default :
            return `Unknown tool: "${name}"`
    }
}

async function runWithTools(userMessage: string) {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
        {
            role: "system",
            content: "你是一名乐于助人的订单客服助手。回答前必须使用可用工具查询真实数据，绝不能猜测订单状态、库存数量或客户资料。"
        },
        {
            role: "user",
            content: userMessage
        }
    ]

    console.log(`\n用户输入：${userMessage}\n`)

    while (true) {
        const response = await client.chat.completions.create({
            model: model,
            messages: messages,
            tools: tools,
            tool_choice: "auto"
        })

        const choice = response.choices[0]
        messages.push(choice.message)

        if (choice.finish_reason == "stop") {
            return choice.message.content?? ""
        }

        if (choice.finish_reason == "tool_calls") {
            const toolCalls = choice.message.tool_calls ?? []
            console.log(`模型请求调用 ${toolCalls.length} 个工具：`)

            for (const call of toolCalls) {
                const args = parseToolArgs(call.function.arguments)
                console.log(`->${call.function.name}(${JSON.stringify(args)})`)

                const result = executeTool(call.function.name, args)
                console.log(`<- ${result}`)

                messages.push({
                    role: "tool",
                    tool_call_id: call.id,
                    content: result
                })
            }
        }
    }
}

async function main() {
    const reply1 = await runWithTools("订单 ORD-002 当前是什么状态？");
    console.log(`助手：${reply1}`)
    console.log("-".repeat(60))


}

main().catch(console.error)