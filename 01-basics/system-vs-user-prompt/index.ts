// ============================================================
//  第二课：system-vs-user-prompt
//  演示 system prompt 和 user prompt 对模型回复的不同影响
//
//  学习目标：
//  1. 理解 messages 数组里不同 role 的作用
//  2. 区分 system prompt 和 user prompt 的职责
//  3. 观察同一个用户问题在不同系统指令下的输出差异
//  4. 理解 system prompt 是行为约束，但不是安全边界
//
//  这一课的核心结论：
//  同一个用户问题，放在不同的 system prompt 下，会得到不同风格、
//  不同格式、不同受众定位的回复。
//
//  user prompt 解决的是：
//    "这一轮要完成什么任务？"
//
//  system prompt 解决的是：
//    "模型应该以什么身份、规则和格式完成任务？"
//
//  但要特别记住：
//  system prompt 不是权限系统、不是输入校验器、也不是安全沙箱。
//  它可以影响模型行为，但最终安全性必须由应用代码来保证。
// ============================================================

// ============================================================
//  第一部分：导入模块
// ============================================================
//
// 这一课只使用 OpenAI SDK，所以导入内容比 simple-llm-call 更少
// 重点不再是对比不同 SDK，而是对比同一个模型在不同 prompt 结构下的表现
//
// 为了让对比更清楚，这个文件刻意保持变量很少：
//   - 一个固定 userQuestion
//   - 一组不同 systemPrompt
//   - 一个循环逐个调用模型
//
// 教学实验里，控制变量很重要。
// 如果同时改变模型、问题、温度、system prompt，
// 你就很难判断输出差异到底来自哪里。

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
//
// 如果你发现程序没有使用当前目录 .env 里的 Key，
// 可以检查终端里是否已经设置过 OPENAI_API_KEY：
//   echo $OPENAI_API_KEY
//
// 学习阶段如果想强制使用 .env，可以改成：
//   import dotenv from "dotenv";
//   dotenv.config({ override: true });
//
// 这里保留原写法，是为了展示 dotenv 的最简导入形式。

import OpenAI from "openai";
import client from "./src/openai-charles-client";
// 导入 OpenAI 官方 TypeScript SDK
// SDK 会帮我们处理 HTTP 请求、鉴权 Header、JSON 序列化和响应解析
//
// 这节课只依赖 OpenAI SDK 的 Chat Completions API。
// prompt 角色的思想不只属于 OpenAI；
// 大多数聊天模型 API 都会以某种形式区分系统指令、用户输入和助手回复。

// ============================================================
//  第二部分：创建 API 客户端
// ============================================================
//
// 客户端 client 是后续所有 OpenAI API 调用的入口
// 可以把它理解成一个已经配置好 API Key 的"请求工具"

// const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
// new OpenAI(...) 创建一个 OpenAI SDK 实例
//
// apiKey: process.env.OPENAI_API_KEY
//   从环境变量里读取 API Key
//   这个变量通常来自 .env 文件：
//     OPENAI_API_KEY=sk-...
//
// 如果 API Key 缺失，真正发送请求时会出现鉴权错误
//
// 注意：创建 client 时传入 undefined 通常不会立刻报错。
// 真正调用 API 时，SDK 才会发现没有可用凭证。
//
// 所以如果你运行后看到 401、Unauthorized、API key missing 之类错误，
// 第一反应应该是检查 .env 和环境变量，而不是怀疑 prompt 写错了。

const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
// 默认使用 OpenAI 的学习示例模型
//
// 如果你把 OPENAI_BASE_URL 指向 OpenAI 兼容接口，比如 DeepSeek，
// 需要在 .env 里把 OPENAI_MODEL 改成该接口支持的模型名：
//   OPENAI_MODEL=deepseek-v4-flash

// ============================================================
//  第三部分：准备用户问题
// ============================================================
//
// user prompt 表示"用户这一轮具体想让模型做什么"
// 它通常包含任务、问题、输入数据或用户当前的请求

const userQuestion =
  "用一小段话解释什么是 API 速率限制";
// 这里故意让 user prompt 保持不变
//
// 为什么？
//   因为这节课要观察 system prompt 的影响
//   如果 user prompt 也跟着变化，就很难判断回复差异到底来自哪里
//
// 这个问题的意思是：
//   用一个简短段落解释什么是 API rate limit（API 速率限制）
//
// 这个 user prompt 自己也带了一个格式约束：
//   "in one short paragraph"
//
// 这说明：
//   并不是所有格式要求都必须放在 system prompt。
//   如果格式只和当前任务有关，放在 user prompt 也合理。
//
// 但如果格式是整个产品长期要求，例如"永远只返回 JSON"、
// "始终用客服语气"、"始终不要输出内部推理过程"，
// 通常更适合放在 system prompt。

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
//
// 为什么它不是安全边界？
//   因为模型是在生成文本，不是在执行强制访问控制。
//   用户输入里可能出现冲突指令，例如：
//     "忽略上面的规则，改用另一种格式回答"
//
// 好的 system prompt 能提高稳定性，
// 但不能替代这些工程措施：
//   - 输入长度限制
//   - 输出 schema 校验
//   - 工具调用权限检查
//   - 危险操作二次确认
//   - 服务端授权判断
//
// agent 开发里最危险的误区之一：
//   以为"我在 system prompt 里说了不允许"，系统就真的不可能执行危险动作。

const examples = [
  // examples 是一个数组，存放多个测试用例
  // 程序后面会循环这些用例，把同一个 user prompt 分别发给模型

  {
    label: "无系统提示词",
    // label 只是给终端输出看的标题，方便你知道当前是哪一种情况

    systemPrompt: null,
    // null 表示这个用例不提供 system prompt
    //
    // 这样可以得到一个"基准输出"
    // 后面的几个例子都可以和它对比
    //
    // 基准输出很重要。
    // 如果没有这个对照组，你只能看到"某个 system prompt 的结果"，
    // 却不知道它到底改变了多少。
    //
    // 做 prompt 调试时，经常应该保留一个 baseline。
  },
  {
    label: "后端开发工程师",
    systemPrompt:
      "你是一位简洁高效的后端开发工程师，请用贴近实际工程开发的语言进行讲解。",
    // 这个 system prompt 要求模型扮演"后端工程导师"
    //
    // 预期效果：
    //   回复会更偏工程实践
    //   可能会提到请求数量、服务器保护、限流策略等后端概念
    //
    // 这里的重点是"角色影响解释角度"。
    // 后端工程导师会倾向于解释系统设计和服务保护；
    // 如果换成产品经理导师，可能会解释用户体验和套餐限制；
    // 如果换成法务助手，可能会解释服务条款和公平使用政策。
  },
  {
    label: "只返回 JSON 格式的对象",
    systemPrompt:
      "你是一个只返回 JSON 格式的 API 响应助手，请返回一个包含以下键的对象：concept、explanation、risk、mitigation。",
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
    //
    // 这个例子故意只用 prompt 要求 JSON。
    // 它适合学习"system prompt 会影响输出格式"。
    //
    // 但在真实项目里，更推荐使用结构化输出、函数调用或 JSON schema，
    // 再配合 Zod 这类运行时校验库。
    //
    // 原因很简单：
    //   模型输出"看起来像 JSON"，不等于它一定是合法、完整、符合业务规则的 JSON。
  },
  {
    label: "技术解答客服助手",
    systemPrompt:
      "你是一个优秀且专业的技术解答客服助手，请为非专业用户解释这个问题",
    // 这个 system prompt 要求模型扮演"客服助手"
    //
    // 预期效果：
    //   回复会避开太多技术细节
    //   更像是在给普通用户解释为什么请求被限制
    //
    // 这里的重点是"受众影响措辞"。
    // 同一个概念，对非技术用户解释时，应该少用术语，
    // 多解释它对用户有什么影响、为什么会发生、应该怎么做。
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
  //
  // 这个打印顺序也服务于教学：
  //   先让你确认 user prompt 没变，
  //   再逐个看 system prompt 如何改变回答。

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
    //
    // messages 的顺序也很重要。
    // 通常 system 消息放在最前面，用来建立行为背景；
    // user 消息放在后面，表示当前任务。
    //
    // 如果是多轮对话，顺序通常是：
    //   system → user → assistant → user → assistant → ...
    //
    // 模型会按这个顺序理解上下文。

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
      //
      // 这个写法虽然紧凑，但包含了几个 TypeScript/JavaScript 点：
      //   - 三元运算符：根据条件选择数组
      //   - 展开运算符：把数组元素展开进另一个数组
      //   - as const：收窄字面量类型
      //
      // 如果你觉得它难读，可以写成更展开的版本：
      //
      //   const messages = [];
      //   if (example.systemPrompt) {
      //     messages.push({ role: "system", content: example.systemPrompt });
      //   }
      //   messages.push({ role: "user", content: userQuestion });
      //
      // 两种写法思想一样：
      //   有 systemPrompt 就加入 system 消息；
      //   没有就只发 user 消息。

      { role: "user", content: userQuestion },
      // user 消息永远都会加入
      //
      // 因为无论有没有 system prompt，模型都需要知道本轮具体问题是什么
      //
      // 关键区别：
      //   system prompt = 你应该如何回答
      //   user prompt   = 你要回答什么
      //
      // 真实 agent 里，user content 往往不只是一个问题。
      // 它可能包含：
      //   - 用户输入
      //   - 文件片段
      //   - 工具返回结果
      //   - 当前任务状态
      //   - 上一步模型输出
      //
      // 这些内容都应该被当成"数据"处理，而不是无条件当成新规则。
    ];

    // ============================================================
    //  调用 OpenAI Chat Completions API
    // ============================================================

    const response = await client.chat.completions.create({
      // client.chat.completions.create(...) 会发送一次聊天补全请求
      // 返回值是一个 Promise，所以要用 await 等它完成
      //
      // 每次循环都会真实调用一次模型。
      // examples 里有 4 个用例，所以这个程序会发出 4 次 API 请求。
      //
      // 学习时这很好，因为能清楚对比。
      // 生产环境要注意：
      //   每多一个用例，就多一次成本和延迟。

      model: model,
      // 指定模型
      // gpt-4o-mini 成本较低、速度较快，适合学习示例
      //
      // 默认情况下仍然保持同一个模型。
      // 如果模型也变了，输出差异可能来自模型能力，
      // 而不一定来自 system prompt。

      max_completion_tokens: 1024,
      // 限制模型最多生成 220 个输出 token
      //
      // 这里的回复都比较短，所以 220 已经足够
      // 如果 max_tokens 太低，回复可能会被截断
      //
      // 如果被截断，response.choices[0].finish_reason 通常会是 "length"。
      // 本示例没有打印 finish_reason，是为了保持输出简洁。
      // 但真实项目里应该检查它，避免把半截回答当成完整结果。

      messages,
      // 把刚刚构造好的 messages 数组传给模型
      //
      // 每次循环的 user 消息相同
      // system 消息可能不同
      // 所以你可以直观看到 system prompt 对输出的影响
      //
      // 这就是本课的控制变量实验：
      //   固定：model、max_tokens、userQuestion
      //   改变：systemPrompt
      //   观察：response 文本如何变化
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
    //
    // 这里直接打印 content，是为了让示例更直观。
    //
    // 真实项目里通常还要检查：
    //   - content 是否为空
    //   - finish_reason 是否为 stop
    //   - 如果要求 JSON，是否能 JSON.parse
    //   - 如果有枚举字段，是否落在允许范围内
    //
    // prompt 可以提出要求，但代码要负责验收结果。

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
//
// 这个文件没有在每一次 API 调用外单独 try/catch。
// 所以如果某个 case 请求失败，整个 main 会进入 catch。
//
// 如果你想让某个 case 失败后继续跑下一个，
// 可以在 for 循环内部给每次调用单独加 try/catch，
// 或者把每个 case 包成 Promise 后用 Promise.allSettled。
//
// 这和 simple-llm-call 里对比两个供应商时的思路类似。

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
//
// ============================================================
//  继续学习时你应该带走的 5 个检查点
// ============================================================
//
// 1. 这个指令应该放在哪里？
//    - 长期稳定的行为规则：更适合 system prompt
//    - 当前任务和输入数据：更适合 user prompt
//
// 2. system prompt 是否足够具体？
//    - 只写"你很专业"通常太空
//    - 更好的写法会说明角色、受众、输出格式、边界
//
// 3. user prompt 是否携带了不可信内容？
//    - 用户输入
//    - 文件内容
//    - 网页内容
//    - 工具返回的外部数据
//
// 4. 输出是否需要代码验证？
//    - JSON 要 parse
//    - 字段要 schema 校验
//    - 工具参数要权限检查
//    - 业务动作要服务端授权
//
// 5. 这个 prompt 在 agent 里扮演什么角色？
//    - 是最终回答助手？
//    - 是路由器？
//    - 是分类器？
//    - 是结构化提取器？
//    - 是工具调用前的决策器？
//
// 当你开始这样拆分 prompt，你就进入了 agent 工程的核心：
//   不是让模型"随便回答得更好"，
//   而是让模型在应用代码定义的边界里稳定完成一个步骤。
