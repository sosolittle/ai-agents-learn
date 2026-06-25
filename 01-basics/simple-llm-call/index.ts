// ============================================================
//  第一课：simple-llm-call
//  同时演示 OpenAI SDK 和 Anthropic SDK 两种调用方式
//
//  学习目标：
//  1. 理解什么是 SDK（Software Development Kit）
//  2. 学会用 TypeScript 调用 LLM API
//  3. 对比 OpenAI 和 Anthropic 两种主流 SDK 的差异
//  4. 掌握 async/await、Promise、错误处理等核心概念
// ============================================================

// ============================================================
//  第一部分：导入模块
// ============================================================
//
// import 语句用来引入其他模块（文件/包）的功能
// 就像你用手机 App 之前，要先下载安装一样
// TypeScript 代码要用某个功能，也要先"导入"它

import dotenv from "dotenv";
// dotenv 是一个工具包，专门用来读取 .env 文件
// .env 文件存放 API Key 等敏感配置，不能写在代码里（会被别人看到）
// dotenv 会把 .env 文件里的变量加载到 process.env 对象中
//
// 举个例子：
//   .env 文件内容：OPENAI_API_KEY=sk-abc123
//   加载后：process.env.OPENAI_API_KEY === "sk-abc123"

dotenv.config({ override: true });
// 调用 config() 方法来执行加载
// { override: true } 的含义：
//   你的电脑终端（shell）里可能已经设置过同名的环境变量
//   不加 override: true → .env 的值不会覆盖已有的环境变量
//   加了 override: true → .env 的值会强制覆盖，确保用的是 .env 里的配置

import OpenAI from "openai";
// 导入 OpenAI 官方的 TypeScript SDK
//
// 什么是 SDK？
//   SDK = Software Development Kit（软件开发工具包）
//   它把复杂的 HTTP 请求封装成了简单的方法调用
//   你不需要自己拼接 URL、设置 Header、处理响应格式
//   只需要调用 SDK 提供的方法，比如 client.chat.completions.create()
//
// 这个 SDK 能调用哪些模型？
//   - OpenAI 自家的：GPT-4o、GPT-4o-mini、o1、o3 等
//   - 兼容 OpenAI 格式的第三方：DeepSeek、Moonshot、智谱 等

import Anthropic from "@anthropic-ai/sdk";
// 导入 Anthropic 官方的 TypeScript SDK
//
// Anthropic 是 Claude 系列模型的开发商
// 这个 SDK 能调用哪些模型？
//   - Anthropic 自家的：Claude Sonnet、Claude Opus、Claude Haiku 等
//   - 兼容 Anthropic 格式的第三方：小米 MiMo 等

// ============================================================
//  第二部分：创建 API 客户端
// ============================================================
//
// "客户端"就是一个帮你跟服务器通信的工具
// 创建客户端时需要告诉它两件事：
//   1. apiKey → 你是谁（身份认证）
//   2. baseURL → 服务器在哪里（API 地址）

// --- OpenAI 客户端 ---

const openaiClient = new OpenAI({
  // new OpenAI(...) → 调用 OpenAI 类的构造函数，创建一个实例
  // 什么是"实例"？
  //   类（Class）就像一个蓝图/模板
  //   实例（Instance）是根据蓝图造出来的具体对象
  //   就像"汽车设计图" → "一辆具体的车"

  apiKey: process.env.OPENAI_API_KEY,
  // 从环境变量读取 API Key
  // process.env 是 Node.js 内置的全局对象，存放所有环境变量
  // 这里的值来自 .env 文件（由上面的 dotenv.config() 加载）

  // baseURL 不设置的话，默认是 "https://api.openai.com/v1"
  // 如果你要调用兼容 OpenAI 格式的其他服务（如 DeepSeek），可以改成：
  //   baseURL: "https://api.deepseek.com/v1"
});

// --- Anthropic 客户端 ---

const anthropicClient = new Anthropic({
  apiKey: process.env.ANTHROPIC_AUTH_TOKEN,
  // Anthropic 用的环境变量名是 ANTHROPIC_AUTH_TOKEN
  // 注意：不同 SDK 的环境变量命名习惯不同
  //   OpenAI 通常叫 xxx_API_KEY
  //   Anthropic 通常叫 xxx_AUTH_TOKEN

  baseURL: process.env.ANTHROPIC_BASE_URL,
  // Anthropic 官方地址是 "https://api.anthropic.com"
  // 如果你要调用兼容 Anthropic 格式的其他服务（如小米 MiMo），改成对应地址
});

// --- 读取模型名称 ---

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
// || 运算符：如果左边是 undefined 或空字符串，就用右边的默认值
// "gpt-4o-mini" 是 OpenAI 最便宜的模型，适合学习和测试

const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514";
// "claude-sonnet-4-20250514" 是 Anthropic 的中端模型，性价比高

// ============================================================
//  第三部分：调用 OpenAI API
// ============================================================
//
// 这个函数演示如何用 OpenAI SDK 调用 GPT 模型
// 每一行都有详细注释，帮你理解整个流程

async function callOpenAI() {
  // ↑ async 关键字：表示这个函数是"异步函数"
  //
  // 什么是异步？
  //   同步（Sync）：排队办事，前一个人没办完，你就得等着
  //   异步（Async）：取号办事，发完请求可以干别的，结果好了会通知你
  //
  // 为什么要用异步？
  //   调用 API 需要等服务器响应（可能要 1-5 秒）
  //   如果用同步，整个程序会卡住等待
  //   用异步，程序可以继续执行其他代码
  //
  // async 函数的特点：
  //   1. 内部可以用 await 关键字
  //   2. 返回值会被自动包装成 Promise 对象

  console.log("=".repeat(50));
  console.log("方式一：OpenAI SDK 调用 GPT 模型");
  console.log("=".repeat(50) + "\n");
  // console.log() → 在终端打印信息
  // "=".repeat(50) → 把 "=" 重复 50 次，用来画分隔线

  const response = await openaiClient.chat.completions.create({
    // ↑ await 关键字：等待异步操作完成
    //
    // openaiClient.chat.completions.create() 返回的是一个 Promise
    // Promise = "承诺"——现在还没有结果，但承诺将来会给你
    // await 的作用：暂停在这里，等 Promise 有结果了再继续
    //
    // 如果不加 await：
    //   response 会是一个 Promise 对象（类似 { <pending> }）
    //   不是你想要的 API 响应数据！
    //
    // ⚠️ await 只能在 async 函数内部使用！

    model: OPENAI_MODEL,
    // 指定要使用的模型
    // 不同模型的能力和价格差异很大：
    //   gpt-4o-mini → 最便宜，速度快，适合简单任务
    //   gpt-4o → 中等价格，能力更强
    //   o1/o3 → 最贵，推理能力最强

    max_tokens: 1024,
    // max_tokens：限制 AI 回复的最大长度
    //
    // 什么是 token？
    //   token 是 LLM 处理文本的最小单位
    //   英文：1 个单词 ≈ 1 个 token（"hello" = 1 token）
    //   中文：1 个字 ≈ 1-2 个 token（"你好" ≈ 2 tokens）
    //   1024 tokens ≈ 500 个中文字 ≈ 750 个英文单词
    //
    // 为什么要限制？
    //   1. 控制成本：token 越多，费用越高
    //   2. 控制时间：token 越多，生成越慢
    //   3. 避免废话：限制长度迫使 AI 更精炼

    messages: [
      // messages 数组：存放对话历史
      // LLM 没有"记忆"，每次调用都要把历史对话一起发过去
      // 这样 AI 才知道上下文（之前聊了什么）

      {
        role: "user",
        // role：这条消息是谁说的
        // "user" → 用户（你）
        // "assistant" → AI 助手（模型）
        // "system" → 系统指令（给 AI 的背景设定，后续课程会讲）
        //
        // 为什么要区分角色？
        //   因为 LLM 是"角色扮演"式工作的
        //   它看到 user 消息，就知道要"回答用户问题"
        //   它看到 assistant 消息，就知道这是"自己之前说的话"

        content:
          "用两句话解释什么是大语言模型（LLM），对象是一个从没接触过AI的程序员。",
        // content：消息的具体内容
        // 这里的提示词（Prompt）很重要，直接影响 AI 的回复质量
        // 好的提示词应该：明确、具体、有上下文
      },
    ],
  });

  // ============================================================
  //  读取 OpenAI 的响应结果
  // ============================================================
  //
  // API 返回的 response 是一个复杂的对象，我们来拆解它的结构：
  //
  // response = {
  //   id: "chatcmpl-abc123",           // 请求的唯一标识
  //   object: "chat.completion",        // 响应类型
  //   created: 1234567890,              // 创建时间戳
  //   model: "gpt-4o-mini-2024-07-18",  // 实际使用的模型
  //   choices: [                        // AI 的回复选项（通常只有 1 个）
  //     {
  //       index: 0,
  //       message: {
  //         role: "assistant",          // 角色
  //         content: "大语言模型是..."   // 回复内容 ← 我们要的就是这个！
  //       },
  //       finish_reason: "stop"         // 停止原因
  //     }
  //   ],
  //   usage: {                          // token 使用统计
  //     prompt_tokens: 25,              // 输入消耗的 token
  //     completion_tokens: 42,          // 输出消耗的 token
  //     total_tokens: 67                // 总消耗
  //   }
  // }

  const choice = response.choices[0];
  // response.choices 是一个数组，存放 AI 的所有回复选项
  // 通常我们只请求 1 个回复，所以用 [0] 取第一个
  // 如果你想让 AI 同时生成多个回复做对比，可以设置 n: 2

  console.log("GPT 的回复：\n");
  console.log(choice.message.content);
  // choice.message.content 就是 AI 的文字回复

  console.log("\n--- Token 使用情况 ---");
  console.log("输入 tokens:  ", response.usage?.prompt_tokens);
  console.log("输出 tokens:  ", response.usage?.completion_tokens);
  console.log("停止原因:     ", choice.finish_reason);
  // ↑ ?. 叫做"可选链"（Optional Chaining）
  //   如果 response.usage 是 null 或 undefined，不会报错，直接返回 undefined
  //   这是一种安全的写法，防止因为某个字段不存在而崩溃
  //
  // finish_reason 可能的值：
  //   "stop"   → AI 正常说完了
  //   "length" → 达到 max_tokens 限制，被强制截断
  //   "tool_calls" → AI 要调用工具（后续课程会讲）
}

// ============================================================
//  第四部分：调用 Anthropic API
// ============================================================
//
// 这个函数演示如何用 Anthropic SDK 调用 Claude 模型
// 注意对比它和 OpenAI 的差异！

async function callAnthropic() {
  console.log("\n" + "=".repeat(50));
  console.log("方式二：Anthropic SDK 调用 Claude 模型");
  console.log("=".repeat(50) + "\n");

  const response = await anthropicClient.messages.create({
    // Anthropic 的接口是 messages.create（不是 chat.completions.create）
    // 虽然功能一样，但 API 设计风格不同
    // 这就是为什么需要不同的 SDK

    model: ANTHROPIC_MODEL,
    // Anthropic 的模型名：claude-sonnet-4-20250514、claude-opus-4-20250514 等

    max_tokens: 1024,
    // 跟 OpenAI 一样，限制回复的最大 token 数

    messages: [
      {
        role: "user",
        content:
          "用两句话解释什么是大语言模型（LLM），对象是一个从没接触过AI的程序员。",
        // 用同样的问题，方便对比两个模型的回复风格
      },
    ],
  });

  // ============================================================
  //  读取 Anthropic 的响应结果
  // ============================================================
  //
  // Anthropic 的返回结构跟 OpenAI 有明显区别：
  //
  // response = {
  //   id: "msg_abc123",                  // 请求的唯一标识
  //   type: "message",                   // 响应类型
  //   role: "assistant",                 // 角色
  //   model: "claude-sonnet-4-20250514", // 实际使用的模型
  //   content: [                         // ← 注意！这里是数组，不是字符串！
  //     {
  //       type: "text",                  // 内容类型
  //       text: "大语言模型是..."         // 文本内容 ← 我们要的
  //     }
  //   ],
  //   stop_reason: "end_turn",           // 停止原因（跟 OpenAI 的命名不同）
  //   usage: {
  //     input_tokens: 25,                // 输入 token（OpenAI 叫 prompt_tokens）
  //     output_tokens: 42                // 输出 token（OpenAI 叫 completion_tokens）
  //   }
  // }
  //
  // ⚠️ 关键区别：OpenAI 的 content 是字符串，Anthropic 的 content 是数组！
  //    为什么要用数组？
  //    因为 Anthropic 的回复可能包含多种类型的内容：
  //      - type: "text"      → 文本回复
  //      - type: "tool_use"  → 工具调用（后续课程会讲）
  //    一个回复里可以同时有文本和工具调用！

  const textBlock = response.content.find((block) => block.type === "text");
  // response.content.find() → 在数组中查找满足条件的元素
  // (block) => block.type === "text" → 箭头函数，判断 block.type 是否等于 "text"
  //
  // 箭头函数是 ES6 引入的简写函数语法：
  //   完整写法：function(block) { return block.type === "text"; }
  //   箭头写法：(block) => block.type === "text"
  //   如果只有一个参数，括号可以省略：block => block.type === "text"

  const reply = textBlock && "text" in textBlock ? textBlock.text : "(无回复)";
  // ↑ 这行代码做了什么？
  //   1. textBlock && ... → 先检查 textBlock 是否存在（不是 null/undefined）
  //   2. "text" in textBlock → 再检查 textBlock 里有没有 "text" 属性
  //   3. 如果都有 → 返回 textBlock.text
  //   4. 如果没有 → 返回 "(无回复)" 兜底
  //
  // 为什么要这么写？
  //   TypeScript 的类型系统需要你明确告诉编译器：这个对象确实有 text 属性
  //   "text" in textBlock 是一个类型守卫（Type Guard）
  //   它让 TypeScript 知道：到这里，textBlock 一定有 text 属性

  console.log("Claude 的回复：\n");
  console.log(reply);

  console.log("\n--- Token 使用情况 ---");
  console.log("输入 tokens:  ", response.usage?.input_tokens);
  console.log("输出 tokens:  ", response.usage?.output_tokens);
  console.log("停止原因:     ", response.stop_reason);
  // 注意命名差异：
  //   OpenAI:     prompt_tokens / completion_tokens / finish_reason
  //   Anthropic:  input_tokens  / output_tokens     / stop_reason
  // 同样的概念，不同公司叫法不同，这就是为什么需要查文档

  // stop_reason 可能的值：
  //   "end_turn"    → AI 正常说完了（OpenAI 叫 "stop"）
  //   "max_tokens"  → 达到限制被截断（OpenAI 叫 "length"）
  //   "tool_use"    → AI 要调用工具（OpenAI 叫 "tool_calls"）
}

// ============================================================
//  第五部分：运行入口
// ============================================================
//
// 这个函数是程序的入口点，负责协调整个执行流程

async function main() {
  // Promise.allSettled()：同时执行多个异步操作
  //
  // 对比几种处理多个 Promise 的方式：
  //
  // 1. await callOpenAI(); await callAnthropic();
  //    → 串行执行，一个完了才开始下一个（慢，但简单）
  //
  // 2. await Promise.all([callOpenAI(), callAnthropic()])
  //    → 并行执行，但任何一个失败就全部失败（快，但不够健壮）
  //
  // 3. await Promise.allSettled([callOpenAI(), callAnthropic()])
  //    → 并行执行，每个独立处理成功/失败（快，且健壮）✅ 我们用这个
  //
  // allSettled 的返回值：
  //   [
  //     { status: "fulfilled", value: undefined },  // callOpenAI 成功
  //     { status: "fulfilled", value: undefined },  // callAnthropic 成功
  //   ]
  //   或者：
  //   [
  //     { status: "fulfilled", value: undefined },  // callOpenAI 成功
  //     { status: "rejected", reason: Error },      // callAnthropic 失败
  //   ]

  const results = await Promise.allSettled([callOpenAI(), callAnthropic()]);

  // 遍历结果，检查是否有失败的
  results.forEach((result, index) => {
    // .forEach() → 遍历数组的每个元素
    // result → 当前元素
    // index → 当前索引（0 或 1）

    const name = index === 0 ? "OpenAI" : "Anthropic";
    // 三元运算符：条件 ? 值1 : 值2
    // 如果 index === 0，返回 "OpenAI"，否则返回 "Anthropic"

    if (result.status === "rejected") {
      // 如果某个调用失败了，打印错误信息
      console.error(`\n${name} 调用失败:`, result.reason?.message || result.reason);
      // `` 反引号包裹的字符串叫做模板字符串（Template Literal）
      // 可以用 ${变量} 插入变量值
    }
  });
}

// ============================================================
//  第六部分：执行程序
// ============================================================
//
// main() 是 async 函数，返回一个 Promise
// .catch() 用来捕获 main() 中未处理的错误

main().catch(console.error);
// 如果 main() 里的代码抛出了错误，会被 .catch() 捕获
// console.error → 打印错误信息到终端（红色文字）
//
// 等价于：
//   main().catch((error) => console.error(error));
//
// 如果不加 .catch()，未处理的 Promise 错误会打印：
//   "UnhandledPromiseRejectionWarning"（未处理的 Promise 拒绝警告）

// ============================================================
//  总结：OpenAI vs Anthropic SDK 对比
// ============================================================
//
// | 对比项         | OpenAI                    | Anthropic                  |
// |---------------|---------------------------|----------------------------|
// | SDK 包名       | openai                    | @anthropic-ai/sdk          |
// | 创建客户端     | new OpenAI({apiKey})      | new Anthropic({apiKey})    |
// | 调用接口       | chat.completions.create() | messages.create()          |
// | 返回内容       | response.choices[0].message.content | response.content.find(...) |
// | 停止原因       | finish_reason             | stop_reason                |
// | Token 统计     | prompt/completion_tokens  | input/output_tokens        |
// | 环境变量       | OPENAI_API_KEY            | ANTHROPIC_AUTH_TOKEN       |
//
// 虽然 API 设计不同，但核心流程是一样的：
//   1. 创建客户端（带 API Key）
//   2. 构造请求（模型名 + 消息列表）
//   3. 发送请求（await）
//   4. 解析响应（取出文本）
//
// 学会了这个模式，以后换任何 LLM 平台都能快速上手！
