// ============================================================
//  第二课：system-vs-user-prompt
//  演示 system prompt 和 user prompt 对模型回复的不同影响
//
//  学习目标：
//  1. 理解 messages 数组里不同 role 的作用
//  2. 区分 system prompt 和 user prompt 的职责
//  3. 观察同一个用户问题在不同系统指令下的输出差异
//  4. 理解 system prompt 是行为约束，但不是安全边界
// ============================================================

// ============================================================
//  第一部分：导入模块
// ============================================================
//
// 这一课只使用 OpenAI SDK，所以导入内容比 simple-llm-call 更少
// 重点不再是对比不同 SDK，而是对比同一个模型在不同 prompt 结构下的表现

import "dotenv/config";
// 这是一种简写导入方式，会自动执行 dotenv 的配置加载逻辑
//
// 它等价于常见的两步写法：
//   import dotenv from "dotenv";
//   dotenv.config();
//
// 作用：
//   读取当前目录下的 .env 文件
//   把 OPENAI_API_KEY 等变量加载到 process.env 中
//
// 注意：
//   这里没有写 { override: true }
//   如果你的终端里已经设置了 OPENAI_API_KEY，终端变量可能优先于 .env 文件

import OpenAI from "openai";
// 导入 OpenAI 官方 TypeScript SDK
// SDK 会帮我们处理 HTTP 请求、鉴权 Header、JSON 序列化和响应解析

// ============================================================
//  第二部分：创建 API 客户端
// ============================================================
//
// 客户端 client 是后续所有 OpenAI API 调用的入口
// 可以把它理解成一个已经配置好 API Key 的"请求工具"

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
// new OpenAI(...) 创建一个 OpenAI SDK 实例
//
// apiKey: process.env.OPENAI_API_KEY
//   从环境变量里读取 API Key
//   这个变量通常来自 .env 文件：
//     OPENAI_API_KEY=sk-...
//
// 如果 API Key 缺失，真正发送请求时会出现鉴权错误

// ============================================================
//  第三部分：准备用户问题
// ============================================================
//
// user prompt 表示"用户这一轮具体想让模型做什么"
// 它通常包含任务、问题、输入数据或用户当前的请求

const userQuestion =
  "Explain what an API rate limit is in one short paragraph.";
// 这里故意让 user prompt 保持不变
//
// 为什么？
//   因为这节课要观察 system prompt 的影响
//   如果 user prompt 也跟着变化，就很难判断回复差异到底来自哪里
//
// 这个问题的意思是：
//   用一个简短段落解释什么是 API rate limit（API 速率限制）

// ============================================================
//  第四部分：准备不同的 system prompt 示例
// ============================================================
//
// system prompt 表示"模型应该以什么身份、风格、规则来完成任务"
// 它通常用来定义：
//   - 助手角色：老师、客服、代码审查员、分类器
//   - 输出风格：简洁、专业、面向非技术用户
//   - 输出格式：JSON、Markdown、固定字段
//   - 行为约束：不要编造、不要输出额外解释等
//
// 重要提醒：
//   system prompt 能影响模型行为，但它不是安全边界
//   真正的权限控制、数据校验、危险操作拦截，必须由你的代码完成

const examples = [
  // examples 是一个数组，存放多个测试用例
  // 程序后面会循环这些用例，把同一个 user prompt 分别发给模型

  {
    label: "No system prompt",
    // label 只是给终端输出看的标题，方便你知道当前是哪一种情况

    systemPrompt: null,
    // null 表示这个用例不提供 system prompt
    //
    // 这样可以得到一个"基准输出"
    // 后面的几个例子都可以和它对比
  },
  {
    label: "Backend engineering tutor",
    systemPrompt:
      "You are a concise backend engineering tutor. Explain with practical engineering language.",
    // 这个 system prompt 要求模型扮演"后端工程导师"
    //
    // 预期效果：
    //   回复会更偏工程实践
    //   可能会提到请求数量、服务器保护、限流策略等后端概念
  },
  {
    label: "JSON-only API responder",
    systemPrompt:
      "You are a JSON-only API responder. Return an object with keys: concept, explanation, risk, mitigation.",
    // 这个 system prompt 要求模型只返回 JSON 风格的对象
    //
    // 预期效果：
    //   回复不再是自然段落
    //   而是类似：
    //     {
    //       "concept": "...",
    //       "explanation": "...",
    //       "risk": "...",
    //       "mitigation": "..."
    //     }
    //
    // 注意：
    //   prompt 要求 JSON，不代表代码可以无条件相信它一定是合法 JSON
    //   真实项目里还需要 JSON.parse + schema 校验（后续课程会讲）
  },
  {
    label: "Customer support assistant",
    systemPrompt:
      "You are a customer support assistant. Explain this to a non-technical user.",
    // 这个 system prompt 要求模型扮演"客服助手"
    //
    // 预期效果：
    //   回复会避开太多技术细节
    //   更像是在给普通用户解释为什么请求被限制
  },
];

// ============================================================
//  第五部分：运行主流程
// ============================================================
//
// main() 是程序入口
// 它会打印用户问题，然后逐个运行上面的 system prompt 示例

async function main() {
  // async 表示这是一个异步函数
  // 因为调用 OpenAI API 需要等待网络响应，所以函数内部会使用 await

  console.log("User prompt:");
  console.log(userQuestion);
  console.log("-".repeat(60));
  // 先打印固定的 user prompt
  // "-".repeat(60) 用来画一条分隔线，让终端输出更容易阅读

  for (const example of examples) {
    // for...of 用来遍历数组
    //
    // 每次循环时：
    //   example 会依次变成 examples 数组中的一个对象
    //   比如第一次是 { label: "No system prompt", systemPrompt: null }

    // ============================================================
    //  构造 messages 数组
    // ============================================================
    //
    // messages 是发给 Chat Completions API 的对话列表
    //
    // 常见 role：
    //   system    → 系统指令：定义模型行为和规则
    //   user      → 用户消息：表示本轮任务或输入
    //   assistant → 助手消息：表示模型之前的回复
    //
    // 这一课重点观察：
    //   同一个 user 消息，在不同 system 消息下会产生怎样的回复差异

    const messages: OpenAI.ChatCompletionMessageParam[] = [
      // OpenAI.ChatCompletionMessageParam[] 是 TypeScript 类型标注
      //
      // 它告诉 TypeScript：
      //   messages 是一个数组
      //   数组中的每个元素都必须符合 OpenAI 聊天消息的格式
      //
      // 这样如果你把 role 写错，或者漏掉 content，编辑器就能更早提醒你

      ...(example.systemPrompt
        ? [{ role: "system" as const, content: example.systemPrompt }]
        : []),
      // 这段写法用来"有条件地加入 system 消息"
      //
      // 拆开来看：
      //
      // example.systemPrompt ? A : B
      //   这是三元运算符
      //   如果 example.systemPrompt 有值，就返回 A
      //   如果是 null，就返回 B
      //
      // 有 systemPrompt 时，返回：
      //   [{ role: "system" as const, content: example.systemPrompt }]
      //
      // 没有 systemPrompt 时，返回：
      //   []
      //
      // 前面的 ... 是展开运算符（spread operator）
      // 它会把数组里的元素展开到 messages 数组中
      //
      // 举例：
      //   [...[{ role: "system", content: "..." }], userMessage]
      //   等价于：
      //   [{ role: "system", content: "..." }, userMessage]
      //
      // 为什么写 "system" as const？
      //   TypeScript 默认可能把 "system" 推断成普通 string
      //   但 OpenAI 类型要求 role 必须是几个固定字面量之一
      //   as const 告诉 TypeScript：这里就是字面量 "system"，不要放宽成 string

      { role: "user", content: userQuestion },
      // user 消息永远都会加入
      //
      // 因为无论有没有 system prompt，模型都需要知道本轮具体问题是什么
      //
      // 关键区别：
      //   system prompt = 你应该如何回答
      //   user prompt   = 你要回答什么
    ];

    // ============================================================
    //  调用 OpenAI Chat Completions API
    // ============================================================

    const response = await client.chat.completions.create({
      // client.chat.completions.create(...) 会发送一次聊天补全请求
      // 返回值是一个 Promise，所以要用 await 等它完成

      model: "gpt-4o-mini",
      // 指定模型
      // gpt-4o-mini 成本较低、速度较快，适合学习示例

      max_tokens: 220,
      // 限制模型最多生成 220 个输出 token
      //
      // 这里的回复都比较短，所以 220 已经足够
      // 如果 max_tokens 太低，回复可能会被截断

      messages,
      // 把刚刚构造好的 messages 数组传给模型
      //
      // 每次循环的 user 消息相同
      // system 消息可能不同
      // 所以你可以直观看到 system prompt 对输出的影响
    });

    // ============================================================
    //  打印当前用例和模型回复
    // ============================================================

    console.log("Case:");
    console.log(example.label);
    // 打印当前示例的名称
    // 例如：No system prompt / Backend engineering tutor

    console.log("\nSystem prompt:");
    console.log(example.systemPrompt ?? "(none)");
    // ?? 是空值合并运算符（Nullish Coalescing）
    //
    // 左边是 null 或 undefined 时，使用右边的默认值
    //
    // 所以：
    //   systemPrompt 为 null → 打印 "(none)"
    //   systemPrompt 有字符串 → 打印具体 system prompt
    //
    // 它和 || 的区别：
    //   || 会把空字符串 ""、0、false 也当成"没有值"
    //   ?? 只把 null 和 undefined 当成"没有值"

    console.log("\nResponse:");
    console.log(response.choices[0].message.content);
    // response.choices[0].message.content 是模型回复文本
    //
    // response.choices 是一个数组
    // 默认情况下通常只有一个候选回复，所以取 [0]
    //
    // 如果你设置 n: 2，就可能得到两个候选回复：
    //   response.choices[0]
    //   response.choices[1]

    console.log("-".repeat(60));
    // 每个用例之间打印分隔线，方便对比输出
  }
}

// ============================================================
//  第六部分：执行程序
// ============================================================
//
// main() 返回 Promise
// .catch(console.error) 用来捕获主流程里没有单独处理的错误

main().catch(console.error);
// 如果 API Key 错误、网络失败、模型名不可用等问题导致请求报错
// 错误会被 .catch() 捕获并打印到终端
//
// 等价于：
//   main().catch((error) => console.error(error));

// ============================================================
//  总结：system prompt vs user prompt
// ============================================================
//
// | 对比项       | system prompt                         | user prompt                  |
// |--------------|----------------------------------------|------------------------------|
// | 主要作用     | 定义行为、角色、格式、约束              | 提供当前任务、问题、输入数据 |
// | 常见内容     | 你是客服/导师/分类器，只返回 JSON       | 请解释 rate limit 是什么     |
// | 变化频率     | 通常由应用开发者控制，较稳定            | 通常由用户输入，每轮都可能变 |
// | 安全含义     | 能引导模型，但不能当作权限系统          | 必须视为不可信输入           |
//
// 在 agent 系统里：
//   system prompt 通常定义 agent 的身份、工具使用规则、输出格式和边界
//   user prompt 通常提供用户目标、当前任务、文件内容或待处理数据
//
// 记住一句话：
//   system prompt 负责"怎么做"
//   user prompt 负责"做什么"
