// ============================================================
//  第二章：tool-use（工具调用）—— 完整三连 demo 版
//
//  🏠 比喻一句话带过（完整展开见 index.ts 文件头）：
//  模型是「锁在会议室里的百科全书式新员工」，工具是他手里的
//  「内线电话」——他只能填申请单打电话，查货员（我们的代码）
//  替他跑腿，把结果念回来，他再回答客户。
//
//  学习目标：
//  1. 理解“模型决定调用什么工具，代码负责真正执行工具”
//  2. 看懂 tools 数组如何描述可用函数和参数 schema
//  3. 学会把 tool_calls 的参数解析后交给 dispatcher
//  4. 理解为什么工具调用需要循环，而不是只调用一次模型
//  5. 观察三个从易到难的 demo：单工具 → 并行多工具 → 多数据源合成
//
//  这一章的核心结论：
//  LLM 不应该直接访问数据库、文件系统或外部服务。
//  它只能“请求调用工具”；是否执行、如何校验、返回什么结果，
//  都由你的 TypeScript 代码控制。
//
//  本模块文件导航：
//  - index2.ts（本文件）：三个 demo 的完整版，工具定义和报错文案
//    都是修正过的版本，注释也最全
//  - index.ts：npm start 运行的精简版，demo 故意查一个不存在的
//    订单号 O-9999，专门演示「查无此单」的错误路径
//  - index_original.ts：最初的英文版，整体注释存档
// ============================================================

import "dotenv/config";
// ③→① 第三方包「副作用导入」：只执行 dotenv/config 的加载逻辑
//    （把 .env 装进 process.env），不从它那里拿任何名字。
import OpenAI from "openai";
// ② 第三方包：本文件同样只在类型上用到它（OpenAI.Chat.* 命名空间）。
import client from "./src/openai-charles-client";
// ③ 自己项目里的文件：带 Charles 抓包开关的客户端。

// const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
// ↑ 被注释的「直连版」写法：不走 Charles 封装、直接建客户端。
//   保留它作对照——想试直连时，注释掉上一行、放开这两行即可。

const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
// 模型名：.env 里配了 OPENAI_MODEL 就用配置的，否则用 gpt-4o-mini。

// 这一章只用 OpenAI 客户端，因为重点是 function calling / tool use 模式。

// ---------------------------------------------------------------------------
// 第一部分：模拟后端（Mock backend）
// 真实项目里这些会换成数据库、Redis 或内部 API 调用。
// 模型永远不会直接执行它们——都是我们的代码替它跑腿。
// ---------------------------------------------------------------------------

// TS 语法：Record<string, {…}> 读作「键是 string、值是大括号里那个
// 形状」的字典。下面三张表就是查货员的「台账」：拿键一翻就拿到
// 整条记录；键不存在时拿到 undefined——下面三个函数正是靠这个
// 判断「查无此单」。
const ORDERS: Record<string, { status: string; item: string; quantity: number }> = {
  "ORD-001": { status: "shipped",    item: "Wireless Headphones", quantity: 1 },
  "ORD-002": { status: "processing", item: "Mechanical Keyboard",  quantity: 2 },
  "ORD-003": { status: "delivered",  item: "USB-C Hub",            quantity: 1 },
};

const INVENTORY: Record<string, { stock: number; sku: string }> = {
  // Mechanical Keyboard 的 stock 故意是 0：demo 2 靠它演示
  // 「模型查到缺货后如实相告，而不是嘴硬说有货」。
  "Wireless Headphones": { stock: 14, sku: "WH-100" },
  "Mechanical Keyboard": { stock: 0,  sku: "MK-200" }, // intentionally out of stock
  "USB-C Hub":           { stock: 32, sku: "UC-300" },
};

// tier 用了字面量联合类型 "standard" | "premium"：只能二选一，
// 写成别的任何字符串都会被编译器当场拦下。
const CUSTOMERS: Record<string, { name: string; email: string; tier: "standard" | "premium" }> = {
  "CUST-42": { name: "Alex Rivera", email: "alex@example.com", tier: "premium"  },
  "CUST-17": { name: "Sam Chen",    email: "sam@example.com",  tier: "standard" },
};

function getOrderStatus(orderId: string): string {
  // 模拟“查订单状态”的后端函数。
  // 注意：模型不会直接执行这个函数，executeTool 才会执行。
  // 查不到时 ORDERS[orderId] 是 undefined → if (!order) 拦下，
  // 返回一句人话错误。这句错误同样会回到模型手里——
  // 它是「有价值的情报」，不是单纯的失败。
  const order = ORDERS[orderId];
  if (!order) return `No order found with ID ${orderId}`;
  // 返回值统一是字符串（JSON.stringify 把对象变文本），
  // 因为 tool 消息的 content 只接受字符串。
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
  // 📤 输入输出走查：CUSTOMERS["CUST-42"]
  //   → '{"name":"Alex Rivera","email":"alex@example.com","tier":"premium"}'
  //   CUSTOMERS["CUST-99"] → undefined → 返回 "No customer found with ID CUST-99"
  const customer = CUSTOMERS[customerId];
  if (!customer) return `No customer found with ID ${customerId}`;
  return JSON.stringify(customer);
}

// ---------------------------------------------------------------------------
// 第二部分：工具定义（Tool definitions）——递给模型的“工具菜单”
// description 告诉它「什么时候」用这个工具；
// 参数的 description 告诉它「怎么填」参数。
// 写得含糊 = 选错工具；缺格式提示 = 参数填错。
// （这不是写给人看的注释，是模型真正读到的说明书。）
// ---------------------------------------------------------------------------

// TS 语法：OpenAI.Chat.ChatCompletionTool[] = OpenAI 包里 Chat 命名空间
// 下的 ChatCompletionTool 类型组成的数组。类型由 SDK 定义好，
// 直接借用，保证和我们传给 create() 的形状完全一致。
const tools: OpenAI.Chat.ChatCompletionTool[] = [
  // tools 是给模型看的“工具菜单”。
  // 里面的 name/description/parameters 会影响模型是否选对工具、参数是否填对。
  //
  // parameters 是一个 JSON Schema（用 JSON 描述「数据长什么样」的
  // 业界标准）：type: "object" 说参数是个对象，properties 列出每个
  // 字段的类型和说明，required 列出哪些字段必填。
  // 模型填参数时就是照着这份 schema「对表」的。
  {
    // 目前 OpenAI 的工具只有 "function" 这一种类型，照抄即可。
    type: "function",
    function: {
      // name 是分机号：必须和下面 executeTool 里 switch 的 case 对上。
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
// 第三部分：parseToolArgs —— 安全解析模型发来的参数字符串
// ⚠️ 模型发来的 arguments 永远是 JSON 字符串，不是现成的对象：
//   它发的是 '{"order_id":"ORD-002"}'（整体是字符串），
//   必须 JSON.parse 一次，之后才能 args.order_id 取值。
// 模型偶尔会生成非法 JSON（少见但可能）：与其让整个循环崩掉，
// 不如返回空对象——executeTool 会报出清晰的「缺少必填参数」，
// 这句报错回到模型手里，它通常能自我纠正、下一圈重试。
// ---------------------------------------------------------------------------

// TS 语法两个点：
//   catch { … }（不写 (e)）——「可选 catch 绑定」：错误对象用不上时
//   可以省掉变量名，ES2019 起支持。index.ts 里写的是老式 catch (e)。
//   as Record<string, string> —— 类型断言：JSON.parse 的返回类型是
//   any（它不知道 JSON 里装了什么），断言是我们向编译器承诺
//   「我知道它长这样」。断言不做运行时检查，只收复类型信息。
function parseToolArgs(raw: string): Record<string, string> {
  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// 第四部分：Dispatcher（分发器）——把模型的工具请求路由到真正的函数
// 这里是安全边界。模型不能运行代码——只能申请运行。
// 鉴权、限流、输入校验都应该加在这一层。
// ---------------------------------------------------------------------------

// TS 语法：switch 按 name 字符串精确匹配，一个 case 对应一个工具；
// default 兜底不可省——模型可能幻觉出一个不存在的工具名，
// 接住它、回一句「未知工具」，比让程序抛异常更稳。
function executeTool(name: string, args: Record<string, string>): string {
  // dispatcher 是非常重要的安全边界：
  // 模型给出的是“请求”，这里的 switch 才决定实际允许调用哪些函数。
  // 🏠 比喻复用：模型隔着柜台递申请单，这里才是盖章放行的窗口。
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
// 第五部分：工具调用循环——循环转下去，直到 finish_reason === "stop"
//
// 为什么一次 API 调用不够？模型拿到工具结果后，可能还要再要
// 一个工具才答得上来（先查订单拿商品名 → 再查库存）。
// 你只管不停循环，直到它自己停下。
// 模型还可以在一圈里同时申请多个工具（并行查询）——
// tool_calls 是数组，永远要逐个遍历，别假设只有 1 个。
//
// 完整消息流（→ 我们发出去的 / ← 模型回的）：
//   → [system, user]
//   ← assistant { tool_calls: [...] }   finish_reason: "tool_calls"
//   → [system, user, assistant, tool(result), tool(result), ...]
//   ← assistant { content: "..." }      finish_reason: "stop"
//
// 模型本身没有记忆：每一圈它都是重新读完整的 messages 才知道
// 「我是谁、用户问了什么、我查到了什么」——所以每一笔都要 push。
// ---------------------------------------------------------------------------

// TS 语法：Promise<string> 是这个 async 函数的返回类型——
// 「将来会产出一个 string 的凭证」。调用方用 await 接收。
async function runWithTools(userMessage: string): Promise<string> {
  // runWithTools 是完整工具调用循环。
  // 它会不断把“模型决定 -> 工具结果 -> 模型继续决定”串起来，
  // 直到模型给出最终自然语言回答。
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    {
      // system 提示词是「纪律委员」：不写这句，模型完全可能
      // 凭常识编一个订单状态。写了，它查不到就会承认查不到。
      role: "system",
      content:
        "你是一名乐于助人的订单客服助手。回答前必须使用可用工具查询真实数据，绝不能猜测订单状态、库存数量或客户资料。",
    },
    { role: "user", content: userMessage },
  ];

  console.log(`\n用户：${userMessage}\n`);

  // 无限循环，出口在体内的两个 if（stop 就 return；tool_calls 就干活再转一圈）
  while (true) {
    // 每一圈都是一次真实的模型调用（花 token）：
    // 带上全部历史 messages + 工具菜单 tools。
    const response = await client.chat.completions.create({
      model: model,
      messages,
      tools,
      // "auto" = 模型自己决定这圈是调工具还是直接回答。
      // 其他可选值："required"（必须调一个工具）、"none"（禁用工具）、
      // 或 { type: "function", function: { name: "..." } } 强制调指定工具。
      tool_choice: "auto",
    });

    // choices 是数组（API 支持一次生成多个候选），我们永远取第 0 个。
    const choice = response.choices[0];
    // 把模型这条回复追加进历史——不能省：
    // tool 消息必须紧跟在「发起调用的 assistant 消息」后面，
    // 少了它，下一条 tool 消息就成了孤儿，API 直接报错。
    messages.push(choice.message); // always append — model needs its own history

    // 出口：模型不再要工具，content 就是最终答案。
    // 本文件用的是 === 严格相等（index.ts 里写的是 ==，
    // 字符串比字符串时两者行为一致，但 === 更不容易埋雷）。
    if (choice.finish_reason === "stop") {
      // ?? 空值合并：content 在纯 tool_calls 回复里可能是 null，兜成空串
      return choice.message.content ?? "";
    }

    if (choice.finish_reason === "tool_calls") {
      const toolCalls = choice.message.tool_calls ?? [];
      console.log(`模型请求调用 ${toolCalls.length} 个工具：`);

      for (const call of toolCalls) {
        // 一个 assistant message 里可能有多个 tool call。
        // 例如用户同时问订单和库存时，模型可以一次请求两个独立查询。
        // arguments 是 JSON 字符串——必须先 parse（见第三部分）。
        const args = parseToolArgs(call.function.arguments);
        console.log(`  → ${call.function.name}(${JSON.stringify(args)})`);

        const result = executeTool(call.function.name, args);
        console.log(`  ← ${result}`);

        // tool_call_id 必须和模型的申请对上号——一圈里有多个工具时，
        // 模型就是靠这个 id 把结果和申请一一配对的。
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: result,
        });
      }

      console.log();
      // 杂活干完，回到 while 顶部：带着新历史再问一次模型
    }
  }
}

// ---------------------------------------------------------------------------
// 第六部分：Demo——三个查询，从单工具调用到并行调用到合成查询
// ---------------------------------------------------------------------------

async function main() {
  // 三个 demo 从简单到复杂：
  // 1. 单工具调用
  // 2. 多工具并行请求
  // 3. 多个数据源合成回答

  // ---------- demo 1：单工具调用 ----------
  // 模型只调一次 get_order_status，拿到结果就回答。
  //
  // 📤 输入输出走查（控制台预期输出，大意）：
  //   用户：订单 ORD-002 当前是什么状态？
  //
  //   模型请求调用 1 个工具：
  //     → get_order_status({"order_id":"ORD-002"})
  //     ← {"status":"processing","item":"Mechanical Keyboard","quantity":2}
  //        ↑ 台账里 ORD-002 是「处理中」的机械键盘 ×2
  //
  //   助手：您的订单 ORD-002 目前正在处理中，商品是 2 把机械键盘。
  //   （最终措辞每次运行会略有不同——模型输出本来就有随机性，
  //     但「查了什么、查到什么」是确定的）
  // 1. Single tool call — model calls get_order_status once and replies
  const reply1 = await runWithTools("订单 ORD-002 当前是什么状态？");
  console.log(`助手：${reply1}\n`);
  console.log("─".repeat(60));

  // ---------- demo 2：并行工具调用 ----------
  // 用户一句话里藏了两个独立诉求：认订单（ORD-001 买的是什么）
  // + 查库存（现在还有货吗）。模型很可能在同一圈里同时申请
  // 两个工具——因为这两个查询互不依赖，一起查更快。
  //
  // 📤 输入输出走查（注意「模型请求调用 2 个工具」那一行）：
  //   用户：我是客户 CUST-42，想再次购买订单 ORD-001 中的
  //         Wireless Headphones。现在有库存吗？
  //
  //   模型请求调用 2 个工具：
  //     → get_order_status({"order_id":"ORD-001"})
  //     ← {"status":"shipped","item":"Wireless Headphones","quantity":1}
  //     → check_inventory({"product_name":"Wireless Headphones"})
  //     ← {"stock":14,"sku":"WH-100"}
  //        ↑ 两条结果各有 tool_call_id，模型靠 id 对号入座
  //
  //   助手：有货！Wireless Headphones 目前库存 14 件……
  //
  // （如果模型选择「先查订单、看到商品名后再查库存」分两圈完成，
  //   也是完全正确的行为——并行是模型自己权衡的，不是我们硬编码的。
  //   想看缺货的对照组，把问题里的商品换成 Mechanical Keyboard：
  //   库存是 0，模型会如实说没货。）
  // 2. Parallel tool calls — model calls get_order_status + check_inventory
  //    in the same round because both lookups are independent
  const reply2 = await runWithTools(
    "我是客户 CUST-42，想再次购买订单 ORD-001 中的 Wireless Headphones。现在有库存吗？"
  );
  console.log(`助手：${reply2}\n`);
  console.log("─".repeat(60));

  // ---------- demo 3：两个工具、合成回答 ----------
  // 这次两个查询属于不同「数据库」：客户资料 + 订单详情。
  // 模型把两份结果拼成一段完整答复——这就是 RAG 之外另一种
  // 「让模型基于真实数据说话」的方式：数据由工具现场查。
  //
  // 📤 输入输出走查：
  //   用户：客户 CUST-17 正在询问订单 ORD-003。
  //         请查询该客户的资料和订单详情。
  //
  //   模型请求调用 2 个工具：
  //     → get_customer_profile({"customer_id":"CUST-17"})
  //     ← {"name":"Sam Chen","email":"sam@example.com","tier":"standard"}
  //     → get_order_status({"order_id":"ORD-003"})
  //     ← {"status":"delivered","item":"USB-C Hub","quantity":1}
  //
  //   助手：客户 Sam Chen（标准客户，sam@example.com）询问的
  //         订单 ORD-003 已签收，商品为 1 个 USB-C Hub。
  //
  // 三个 demo 连着看，能发现一个规律：我们从头到尾没写任何
  // 「先查什么后查什么」的流程代码——流程是模型读着工具菜单
  // 自己决定的。我们只负责：提供菜单 + 执行 + 回填结果。
  // 3. Two tools, combined response — model pulls profile + order together
  const reply3 = await runWithTools(
    "客户 CUST-17 正在询问订单 ORD-003。请查询该客户的资料和订单详情。"
  );
  console.log(`助手：${reply3}\n`);
}

// 顶层兜底：main() 是 async，任何一圈抛出的错误（网络断、key 无效）
// 都会被这里接住打到控制台，而不是变成无人处理的 rejection。
main().catch(console.error);
