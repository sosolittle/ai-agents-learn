// ============================================================
//  第二章：tool-use（工具调用）
//
//  🏠 生活化比喻（本章主比喻，贯穿整个文件）：
//  模型本身像一个「百科全书式的新员工」：什么都懂一点，
//  但被锁在会议室里，摸不到公司的订单系统。
//  工具（tool）就是我们递给他的「工牌 + 内线电话」——
//  他不能自己翻档案柜，但他可以打电话问查货员：
//  "帮我查一下 ORD-001 发货了没"，查货员（我们的代码）
//  去系统里查好，把结果念给他，他再组织语言回答客户。
//
//  学习目标：
//  1. 看懂「模型决定调哪个工具 → 代码执行 → 结果还给模型」的完整一圈
//  2. 理解 tools 数组的 JSON Schema 就是工具的「说明书」
//  3. 学会把工具执行结果用 tool 角色塞回 messages 继续对话
//  4. 观察工具「查无此单」时模型如何应对——本文件的 demo
//     特意用了一个不存在的订单号，专门走一遍错误路径
//
//  本模块文件导航：
//  - index.ts（本文件）：npm start 运行的是它。三个工具 +
//    一个「故意查错订单号」的 demo，看模型如何处理查不到的情况
//  - index2.ts：完整三连 demo（单工具 / 并行多工具 / 多数据源
//    合成回答），是本章最完整的参考实现
//  - index_original.ts：最初的英文版，整体注释存档，供对照
//
//  这一章的核心结论：
//  模型永远不直接碰数据库、文件系统或外部服务。
//  它只能「申请」调用工具；批不批、怎么校验、返回什么，
//  全由我们的 TypeScript 代码说了算——这是 agent 安全的第一道门。
// ============================================================

// ------------------------------------------------------------
// 导入区：第一课讲过 import 的三类来源，这里全用上了
// ------------------------------------------------------------

// ① 第三方包「副作用导入」：没有 from、没有拿到任何名字，
//    只是让 dotenv/config 执行一次，把 .env 里的变量装进 process.env。
//    等价于第一课的 import dotenv + dotenv.config()，只是更省一行。
import "dotenv/config"

// ② 第三方包：OpenAI SDK。注意本文件其实没 new OpenAI(...)——
//    引它主要是为了借类型（下面 tools、messages 的类型都住在
//    OpenAI.Chat 这个命名空间里）。真正的客户端来自下面这行：
import OpenAI from "openai";

// ③ 自己项目里的文件：带 Charles 抓包开关的 OpenAI 客户端。
//    要不要抓包由环境变量决定，业务代码一律 import 它。
import client from "./src/openai-charles-client"

// Node.js 内置模块。本文件目前没用到它（预留的导入，不改代码）。
import * as child_process from "node:child_process";

// 模型名：优先读 .env 里的 OPENAI_MODEL，没配就用默认值。
// `||` 的短路特性——左边是假值（undefined/空串）时才用右边。
const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

// ↓↓↓ 第一版草稿（只有一条订单），整体注释保留作对照。
//    24 行起是正式版：三条订单 + 拆得更开的类型定义。
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

// ------------------------------------------------------------
// 第一部分：类型与模拟数据——先说清「查货员查的东西长什么样」
// ------------------------------------------------------------

// TS 语法：字面量联合类型（literal union）。
// OrderStatus 只允许这三种字符串，赋成别的任何值（如 "SHIPPED"、
// "shipped "）都会被编译器当场拦下——相当于把「合法状态清单」
// 写进了类型里，比笼统的 string 安全得多。
type OrderStatus = "processing" | "shipped" | "delivered"

// TS 语法：type 别名 = 给一个对象形状起名字，起完到处复用。
// status 用上面的 OrderStatus，item/quantity 用基础类型。
type Order = {
    status: OrderStatus,
    item: string,
    quantity: number
}

// TS 语法：Record<string, Order> 是 TS 内置的工具类型，意思是
// 「键是 string、值是 Order 的字典」——一本订单台账：
// 拿订单号（键）一翻，就能拿到整条订单（值）。
//
// 📤 输入输出走查（台账怎么用）：
//   ORDERS["ORD-001"] → { status: "shipped", item: "Wireless Headphones", quantity: 1 }
//   ORDERS["ORD-009"] → undefined（没这条记录——下方 getOrderStatus
//                       正是靠这个 undefined 判断「查无此单」）
const ORDERS: Record<string, Order> = {
    "ORD-001": {status: "shipped", item: "Wireless Headphones", quantity: 1},
    "ORD-002": {status: "processing", item: "Mechanical Keyboard", quantity: 2},
    "ORD-003": {status: "delivered", item: "USB-C Hub", quantity: 1},
}

// 库存表：Record 的值也可以现场写对象类型（不必先起名字）。
// { stock: number; sku: string } —— 结构小、只在这里用，就地定义更顺手。
// 注意 Mechanical Keyboard 的 stock 是 0：index2.ts 的 demo 靠它演示
// 「模型查到缺货后如实相告，而不是嘴硬说有货」。
const INVENTORY: Record<string, { stock: number; sku: string }> = {
    "Wireless Headphones": {stock: 14, sku: "WH-100"},
    "Mechanical Keyboard": {stock: 0, sku: "MK-200"},
    "USB-C Hub": {stock: 32, sku: "UC-300"},
};

// 客户表：tier 又用了一次字面量联合（"standard" | "premium"）。
// 这种「值只能二选一」的字段，配合联合类型最不容易写错。
const CUSTOMERS: Record<string, { name: string; email: string; tier: "standard" | "premium" }> = {
    "CUST-42": {name: "Alex Rivera", email: "alex@example.com", tier: "premium"},
    "CUST-17": {name: "Sam Chen", email: "sam@example.com", tier: "standard"},
};

// ------------------------------------------------------------
// 第二部分：工具菜单（tools 数组）——递给模型的「内线电话簿」
// ------------------------------------------------------------
// 每次请求，模型都会读到这份菜单：
//   name        → 分机号（真正执行的函数名）
//   description → 什么情况该打这个分机（模型选工具的主要依据）
//   parameters  → JSON Schema，通话前要报哪些信息、什么格式
// 这不是写给人看的注释，是模型真正读到的「产品说明书」——
// 写得含糊，模型就会选错工具、填错参数。
//
// TS 语法：OpenAI.Chat.ChatCompletionTool[] 读作「OpenAI 包里
// Chat 命名空间下的 ChatCompletionTool 类型组成的数组」。
// 类型住在 SDK 的命名空间里，我们直接借用而不自己定义，
// 保证形状和 SDK 期待的一模一样。
//
// 📤 输入输出走查（以查订单为例）：
//   用户问："我的订单 ORD-001 到哪了？"
//   ① 模型读到这份菜单，发现 get_order_status 能查这个
//   ② 模型输出：{ name: "get_order_status",
//                 arguments: "{\"order_id\": \"ORD-001\"}" }
//      —— 模型只是「填了一张申请单」，它自己查不了（还在会议室里）
//   ③ 我们的代码（下方 executeTool）执行真正查询 →
//      '{"status":"shipped","item":"Wireless Headphones","quantity":1}'
//   ④ 查询结果包成 role: "tool" 的消息塞回 messages，再问模型一次
//   ⑤ 模型生成："您的耳机已发货 📦"
const tools: OpenAI.Chat.ChatCompletionTool[] = [
    {
        // type: "function" 表示这是「函数型工具」——目前 OpenAI
        // 工具只有这一种类型，照抄即可。
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
                        // ⚠️ 易错点（原作者也踩了）：这段 description 是从
                        // check_inventory 复制来的，写的是「商品名称」，
                        // 但它应该描述「客户编号，格式 CUST-XX，例如 CUST-42」。
                        // description 是模型填参数的唯一依据，写错会误导它
                        // 填出错误格式的值。代码按约定原样保留；
                        // 修正版见 index2.ts 的同一位置。
                        description: "系统中保存的准确商品名称，例如“Wireless Headphones”"
                    }
                },
                required: ["customer_id"]
            }
        }
    }
]

// ------------------------------------------------------------
// 第三部分：真正的「后端」——查货员们的实际工作
// ------------------------------------------------------------
// 三个函数分别模拟查订单 / 查库存 / 查客户。真实项目里，
// 这里会是一次数据库查询或内部 API 请求。
// 注意返回值类型都是 string：工具结果最终要作为 tool 消息的
// content 塞回对话，而 content 只能是字符串——所以查到的对象
// 统一 JSON.stringify 成文本再交出去。

function getOrderStatus(orderId: string): string {
    // 台账里翻不到时 ORDERS[orderId] 是 undefined，
    // if (!order) 把它拦下来，返回一句人话错误。
    // 这句错误同样会作为工具结果回到模型手里——
    // 它是「有价值的情报」，模型靠它向用户如实解释。
    const order = ORDERS[orderId]
    if (!order) return `No order found with ID ${orderId}`;
    // TS 语法：反引号模板字符串，${} 里可以放任何表达式。
    return JSON.stringify(order)
    // JSON.stringify(对象) → '{"status":"shipped",...}' 这样的字符串
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

// ------------------------------------------------------------
// 第四部分：参数解析——把模型的「申请单」从字符串变回对象
// ------------------------------------------------------------
// ⚠️ 关键事实：模型发来的 arguments 永远是一个 JSON 字符串，
// 不是现成的对象。比如它发的是 '{"order_id":"ORD-001"}'
// （整体是个字符串），所以必须 JSON.parse 一次，
// 之后才能写 args.order_id 去取值。
//
// TS 语法：
//   try / catch —— 模型偶尔会生成非法 JSON（括号不配对之类），
//   JSON.parse 会直接抛异常。catch 住并返回空对象 {}，
//   不让整个循环崩掉；空对象会让 executeTool 报「缺少必填参数」，
//   这句报错回到模型那里，它通常能自我纠正、下一圈重试。
//
//   Partial<Record<string, string>> —— 「键值都是 string 的对象，
//   但每个属性都可以缺席」。为什么用 Partial？因为解析失败时
//   返回的 {} 就是「所有属性都缺席」的对象，类型上完全说得通。
//
//   as Partial<Record<...>> —— 类型断言：JSON.parse 的返回类型
//   本来是 any（它不知道 JSON 里装了什么），断言是我们向编译器
//   承诺「我知道它长这样」。断言不做任何运行时检查，只收复类型信息。

function parseToolArgs(raw: string): Partial<Record<string, string>> {
    try {
        return JSON.parse(raw) as Partial<Record<string, string>>
    } catch (e) {
        return {}
    }
}

// ------------------------------------------------------------
// 第五部分：dispatcher（分发器）——工具调用的安全边界
// ------------------------------------------------------------
// 模型递来的只是「申请单」，这个 switch 才是真正盖章的柜台：
// 只有列在 case 里的函数才会被执行。真实项目里，鉴权、限流、
// 输入校验都应该加在这一层——模型永远隔着柜台递单子，
// 不能自己翻进后台。
//
// TS 语法：switch 按 name 字符串精确匹配，一个 case 对应一个工具；
// default 兜底不可省——模型可能幻觉出一个根本不存在的工具名。
//
// ⚠️ 易错点：第 2、3 个 case 里的报错文案是从第 1 个 case
// 复制来的，都写着 "order_id"，但那里缺的其实是
// product_name / customer_id。不影响主流程（只有参数缺失这条
// 少见路径会被误导），但是「复制粘贴改不干净」的经典标本；
// index2.ts 里是修正过的版本。

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

// ------------------------------------------------------------
// 第六部分：工具调用循环——本章的心脏
// ------------------------------------------------------------
// 为什么需要 while 循环、而不是只调一次模型？
// 因为拿到工具结果后，模型可能还要再查一个工具才答得上来：
//   用户："我订的耳机还有货吗？"
//   第 1 圈：模型先查订单 → 得知商品是 Wireless Headphones
//   第 2 圈：模型再查库存 → 得知 stock: 14
//   第 3 圈：模型不再要工具（finish_reason = "stop"），直接回答
// 所以套路是反复「请求模型 → 执行它要的工具 → 结果塞回去」，
// 直到模型亲口说"我答完了"。
//
// messages 的演变（一次查订单，一圈一圈长出来）：
//   起步：  [system, user]
//   第 1 圈后：[system, user, assistant(tool_calls), tool(查询结果)]
//   第 2 圈后：[..., assistant(最终回答)]
// 模型本身没有记忆——每一圈它都是重新读完整的 messages
// 才知道"我是谁、用户问了什么、我查到了什么"。
// 所以每一笔都要 push 进去，少一笔对话就断了。

async function runWithTools(userMessage: string) {
    // 对话的起点：system 定纪律 + user 放问题。
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
        {
            // system 消息为什么强调「必须查工具、绝不能猜」？
            // 因为不强调的话，模型完全可能凭常识编一个订单状态
            // （"一般 3-5 天发货"之类的通用话术）。这句提示词是
            // 把「诚实」变成硬性纪律——查不到就承认查不到。
            role: "system",
            content: "你是一名乐于助人的订单客服助手。回答前必须使用可用工具查询真实数据，绝不能猜测订单状态、库存数量或客户资料。"
        },
        {
            role: "user",
            content: userMessage
        }
    ]

    console.log(`\n用户输入：${userMessage}\n`)

    // TS 语法：while (true) 是「无限循环」，真正的出口在循环体内
    // 的两个 if（stop 就 return，tool_calls 就处理后再转一圈）。
    // 循环每一圈都会完整执行一次「问模型」+「干杂活」。
    while (true) {
        // await：等这一次 API 请求回来再往下走（第一课讲过的
        // 异步等待）。每一圈都是一次真实的模型调用，都要花 token。
        const response = await client.chat.completions.create({
            model: model,
            messages: messages,
            tools: tools,
            // tool_choice: "auto" = 模型自己决定这圈是调工具还是直接回答。
            // 其他可选值："required"（必须调一个工具）、"none"（禁用工具）、
            // 或指定 { type: "function", function: { name: "..." } } 强制调某一个。
            tool_choice: "auto"
        })

        // response.choices 是数组（API 支持一次生成多个候选），
        // 我们没要多个，所以永远取第 0 个。
        const choice = response.choices[0]
        // 把模型的回复（可能带 tool_calls）追加进历史。
        // 这一步不能省：tool 消息必须紧跟在「发起调用的那条
        // assistant 消息」后面，否则 API 直接报错。
        messages.push(choice.message)

        // 出口 A：模型不打算再调工具了，content 就是最终答案。
        //
        // TS 语法：这里用的是 ==（宽松相等），index2.ts 里是 ===（严格相等）。
        // 两者在「字符串 vs 字符串」时行为一致，所以本文件没出事；
        // 但 == 会做类型转换（如 1 == "1" 为 true），容易埋雷，
        // 建议养成默认写 === 的习惯。
        if (choice.finish_reason == "stop") {
            // TS 语法：?? 空值合并——左边是 null/undefined 时才用右边。
            // 模型光发 tool_calls 时 content 可能是 null，这里兜成空串。
            return choice.message.content?? ""
        }

        // 分支 B：模型这圈要调工具。逐个执行、逐个回填。
        if (choice.finish_reason == "tool_calls") {
            // tool_calls 是数组：模型可以一圈同时申请多个独立查询
            // （比如同时查订单和库存），所以要 for 循环，别假设只有一个。
            const toolCalls = choice.message.tool_calls ?? []
            console.log(`模型请求调用 ${toolCalls.length} 个工具：`)

            for (const call of toolCalls) {
                // arguments 是 JSON 字符串（见第四部分），先解析成对象
                const args = parseToolArgs(call.function.arguments)
                console.log(`-> ${call.function.name}(${JSON.stringify(args)})`)

                // 真正执行：进 dispatcher，由我们的代码盖章放行
                const result = executeTool(call.function.name, args)
                console.log(`<- ${result}`)

                // 把工具结果包成 role: "tool" 的消息塞回历史。
                // tool_call_id 必须原样抄 call.id——模型同时申请
                // 多个工具时，就靠这个 id 把结果和申请一一配对。
                messages.push({
                    role: "tool",
                    tool_call_id: call.id,
                    content: result
                })
            }
            // 这圈杂活干完，回到 while 顶部：带着新历史再问一次模型
        }
    }
}

// ------------------------------------------------------------
// 第七部分：demo——故意查一个不存在的订单号
// ------------------------------------------------------------
// 用户输入是 "O-9999"，不符合台账里的 ORD-XXX 格式，
// ORDERS 里自然也没有这条记录。走查一遍完整链路：
//
// 📤 输入输出走查（控制台预期输出，大意）：
//   用户输入：订单 O-9999 当前是什么状态？
//
//   模型请求调用 1 个工具：
//   -> get_order_status({"order_id":"O-9999"})
//   <- No order found with ID O-9999
//      ↑ 台账查无此单，这句错误字符串作为 tool 消息回到模型
//
//   助手：抱歉，系统中查不到订单 O-9999，请核对订单号……
//      ↑ 模型拿到「查无此单」后组织的人话回答（措辞每次会变）
//
// 这个 demo 演示的是工具调用里同样重要的另一半：错误路径。
// 工具结果不必总是成功——「查无此单」本身也是有价值的情报。
// 配合 system 提示词里的「绝不能猜测」，模型会坦然承认查不到，
// 而不是编造一个状态。想想如果它编了，客服场景会多尴尬。

async function main() {
    const reply1 = await runWithTools("订单 O-9999 当前是什么状态？");
    console.log(`助手：${reply1}`)
    console.log("-".repeat(60))


}

// TS 语法：main() 是 async 函数，返回 Promise；.catch 把整个
// 异步流程里任何一圈抛出的错误（网络断、API Key 无效……）
// 接住打到控制台，而不是变成无人处理的 rejection 静默挂掉。
main().catch(console.error)