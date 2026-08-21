// ============================================================
//  第一课：simple-llm-call
//  同时演示 OpenAI SDK 和 Anthropic SDK 两种调用方式
//
//  🏠 生活化比喻：
//  调用 LLM 就像给一位「住在云端的顾问」打工作电话：
//    SDK        → 官方电话总机（帮你接通，不用管内部线路）
//    messages   → 通话前递过去的便签（顾问没有记忆，全靠便签了解来意）
//    response   → 对方回传的备忘录（一个大 JSON，答案藏在里面）
//  这一课要做的，就是把这一通电话完整地打熟练。
//
//  学习目标：
//  1. 理解什么是 SDK（Software Development Kit）
//  2. 学会用 TypeScript 调用 LLM API
//  3. 对比 OpenAI 和 Anthropic 两种主流 SDK 的差异
//  4. 掌握 async/await、Promise、错误处理等核心概念
//
//  这一课的核心结论：
//  Agent 并不是一个神秘的新物种。它的最小组成单元，就是一次
//  "把 messages 发给模型，然后读取 response" 的 API 调用。
//
//  后续更复杂的能力，例如：
//  - 多轮对话
//  - 工具调用
//  - 任务规划
//  - 记忆管理
//  - 多 Agent 协作
//  本质上都是在这个最小单元外面加上应用代码、状态管理和控制逻辑。
//
//  所以这节课不要急着追求"智能体有多智能"。
//  先把一次调用的输入、输出、错误、token、模型参数理解扎实。
// ============================================================

// ============================================================
//  第一部分：导入模块
// ============================================================
//
// import 语句用来引入其他模块（文件/包）的功能
// 就像你用手机 App 之前，要先下载安装一样
// TypeScript 代码要用某个功能，也要先"导入"它
//
// 在 Node.js 项目里，import 的来源通常有三类：
//   1. Node.js 内置模块，例如 fs、path、http
//   2. 第三方 npm 包，例如 dotenv、openai、@anthropic-ai/sdk
//   3. 你自己项目里的文件，例如 ./tools、./agent、./utils
//
// 这一课只用第三方 npm 包。
// 这些包来自 package.json 的 dependencies，需要先 npm install。

import dotenv from "dotenv";
// dotenv 是一个工具包，专门用来读取 .env 文件
// .env 文件存放 API Key 等敏感配置，不能写在代码里（会被别人看到）
// dotenv 会把 .env 文件里的变量加载到 process.env 对象中
//
// 📤 输入输出走查（dotenv 到底做了什么）：
//   输入（.env 文件内容）：OPENAI_API_KEY=sk-abc123
//   输出（加载后的 process.env）：process.env.OPENAI_API_KEY === "sk-abc123"

dotenv.config({ override: true });
// 调用 config() 方法来执行加载
// { override: true } 的含义：
//   你的电脑终端（shell）里可能已经设置过同名的环境变量
//   不加 override: true → .env 的值不会覆盖已有的环境变量
//   加了 override: true → .env 的值会强制覆盖，确保用的是 .env 里的配置
//
// 为什么这一行要尽量放在创建客户端之前？
//   因为 new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
//   会从 process.env 里读取变量。
//
//   如果你先创建客户端，再加载 .env，客户端拿到的可能就是 undefined。
//
// 学习阶段用 override: true 很方便：
//   你改 .env 后更容易确认程序用的是当前 lesson 的配置。
//
// 生产环境要更谨慎：
//   线上通常由部署平台注入环境变量，不一定希望 .env 覆盖它。

import OpenAI from "openai";
// 导入 OpenAI 官方的 TypeScript SDK
//
// 什么是 SDK？
//   SDK = Software Development Kit（软件开发工具包）
//   🏠 它就是模型公司的「官方电话总机」：
//   你不需要知道内部线路怎么接、话务怎么转，
//   只要拨对分机号（方法名，比如 client.chat.completions.create）、
//   报清楚需求（参数），总机就帮你把电话接到模型那一头。
//   它把复杂的 HTTP 请求封装成了简单的方法调用
//   你不需要自己拼接 URL、设置 Header、处理响应格式
//   只需要调用 SDK 提供的方法，比如 client.chat.completions.create()
//
// 如果不用 SDK，调用 LLM API 大概需要自己做这些事：
//   1. 用 fetch/axios 发送 POST 请求
//   2. 拼接正确的 API 地址
//   3. 在 Header 里加 Authorization: Bearer <API_KEY>
//   4. 把请求体序列化成 JSON
//   5. 判断 HTTP 状态码
//   6. 解析 JSON 响应
//   7. 处理流式输出、工具调用、错误对象等细节
//
// SDK 的价值不是"更高级"，而是让你少写重复的底层样板代码。
// 真实项目里，SDK 之上通常还会再包一层你自己的 LLM client，
// 用来统一日志、重试、成本统计、模型切换和错误处理。
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
//
// 可以把客户端理解成一个"带好证件、知道地址的快递员"：
//   - apiKey 是证件，证明你有权调用服务
//   - baseURL 是地址，决定请求发到哪个模型服务商
//   - 后面的 create() 调用，就是让这个快递员送出一次请求
//
// 注意：创建客户端通常不会立刻发网络请求。
// 真正联网发生在 chat.completions.create() 或 messages.create() 这类方法执行时。

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
  //
  // ⚠️ 为什么 API Key 绝不能直接写在代码里？（高危易错点）
  //   1. 代码可能会提交到 Git 仓库
  //   2. 仓库可能会同步到 GitHub
  //   3. API 按 token 计费，Key 泄漏 = 别人拿你的钱包刷额度
  //   4. 泄漏的 Key 需要立刻吊销和替换
  //
  // 所以配置和代码要分离：
  //   代码负责"怎么调用"
  //   .env 负责"用哪个账号/地址/模型调用"

  // baseURL 不设置的话，默认是 "https://api.openai.com/v1"
  // 如果你要调用兼容 OpenAI 格式的其他服务（如 DeepSeek），可以改成：
  //   baseURL: "https://api.deepseek.com/v1"
  //
  // 兼容 OpenAI 格式是什么意思？
  //   有些模型服务商虽然不是 OpenAI，但它们的 HTTP 接口设计成了
  //   和 OpenAI 类似的请求/响应格式。
  //
  //   这样你可以继续使用 OpenAI SDK，只改 apiKey、baseURL 和 model。
  //
  // 但要注意：
  //   "接口兼容"不代表"能力完全一样"。
  //   不同服务商对工具调用、结构化输出、上下文长度、错误码的支持可能不同。
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
  //
  // 这里把 baseURL 写成环境变量，是为了方便切换服务地址。
  // 学习时你可以在 .env 里改配置，不需要动 TypeScript 源码。
  //
  // 这也是 agent 项目里很常见的做法：
  //   模型供应商、模型名称、超时时间、日志级别等，尽量配置化。
});

// --- 读取模型名称 ---

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
// || 运算符：如果左边是 undefined 或空字符串，就用右边的默认值
// "gpt-4o-mini" 是 OpenAI 最便宜的模型，适合学习和测试
//
// 📤 输入输出走查（|| 默认值什么时候生效）：
//   .env 里写了 OPENAI_MODEL=gpt-4o      → OPENAI_MODEL === "gpt-4o"
//   .env 里没写这个变量（undefined）      → 落到默认值 "gpt-4o-mini"
//   .env 里只写了个空（OPENAI_MODEL=）    → 空字符串也算假值 → 还是 "gpt-4o-mini"
//
// 为什么不把模型名完全写死？
//   因为模型选择经常会变：
//   - 开发环境用便宜模型
//   - 线上环境用更强模型
//   - 评测时对比多个模型
//   - 某个供应商故障时临时切换
//
// 用环境变量可以把"代码逻辑"和"运行配置"分开。
//
// 小提醒：
//   || 会把空字符串 "" 也当成假值。
//   如果你希望只在 undefined/null 时使用默认值，可以用 ?? 运算符。
//   本例用 || 足够直观，适合入门。

const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514";
// "claude-sonnet-4-20250514" 是 Anthropic 的中端模型，性价比高
//
// 模型名通常不是随便起的字符串。
// 它可能包含：
//   - 模型系列：claude、gpt、o 等
//   - 能力等级：sonnet、opus、mini 等
//   - 版本日期：20250514 这类数字
//
// 版本日期很重要：
//   同一个系列的新旧版本可能在输出风格、工具调用稳定性、价格上都有差异。
//   真正做生产系统时，通常会固定模型版本，避免模型悄悄变化影响业务。

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
  //   🏠 像点外卖：下单后你不用搬个凳子守在门口干等（订单还在
  //   "配送中" = Promise 未完成），可以先去干别的；骑手到了
  //   （Promise resolve）再回来取餐、接着吃饭。
  //   await 就是"暂停在这里，等骑手到了再继续"的那个动作。
  //
  //   写过前端 fetch 的同学可以直接类比：
  //     const res = await fetch("/api/xxx")
  //   ← 同一个 await、同一种"等网络响应再往下走"的套路。
  //
  // 为什么要用异步？
  //   调用 API 需要等服务器响应（可能要 1-5 秒）
  //   如果用同步，整个程序会卡住等待
  //   用异步，程序可以继续执行其他代码
  //
  // async 函数的特点：
  //   1. 内部可以用 await 关键字
  //   2. 返回值会被自动包装成 Promise 对象
  //
  // 换句话说：
  //   async function callOpenAI() { ... }
  //   的返回类型可以理解为 Promise<void>
  //
  // 即使函数里没有显式 return，调用它也会得到一个 Promise。
  // 这就是后面 Promise.allSettled([callOpenAI(), callAnthropic()]) 能工作的原因。

  console.log("=".repeat(50));
  console.log("方式一：OpenAI SDK 调用 GPT 模型");
  console.log("=".repeat(50) + "\n");
  // console.log() → 在终端打印信息
  // "=".repeat(50) → 把 "=" 重复 50 次，用来画分隔线
  //
  // 在学习型代码里，多打印中间信息很有价值。
  // 因为你不仅要看到"最终答案"，还要看到：
  //   - 现在调用的是哪个服务商
  //   - 请求是否真的发出去了
  //   - 响应里的 token 和停止原因是什么
  //
  // 真实 agent 系统也需要日志，只是通常会用日志库，而不是 console.log。

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
    //
    // 这一行是整个示例最核心的地方：
    //
    // 📤 输入输出走查（把这一行拆开看，以 content: "你好" 为例）：
    //   发送出去的请求体长这样：
    //     {
    //       model: "gpt-4o-mini",
    //       max_tokens: 1024,
    //       messages: [{ role: "user", content: "你好" }]
    //     }
    //   收回来的 response 是一个大 JSON，
    //   我们要的答案藏在 response.choices[0].message.content 这条路径里
    //   （完整响应结构在下方"读取 OpenAI 的响应结果"一节逐层拆解）
    //
    // 绝大多数 agent 框架再复杂，底层都会反复做类似的事情：
    //   1. 准备上下文
    //   2. 调模型
    //   3. 解析结果
    //   4. 决定下一步

    model: OPENAI_MODEL,
    // 指定要使用的模型
    // 不同模型的能力和价格差异很大：
    //   gpt-4o-mini → 最便宜，速度快，适合简单任务
    //   gpt-4o → 中等价格，能力更强
    //   o1/o3 → 最贵，推理能力最强
    //
    // 选模型时不要只看"哪个最强"。
    // 更实用的判断是：
    //   - 这个任务需要多强的推理？
    //   - 用户能接受多高的延迟？
    //   - 每次调用能接受多少成本？
    //   - 输出是否需要特别稳定？
    //
    // 在 agent 里，不同步骤可以用不同模型：
    //   - 路由/分类：便宜且稳定的模型
    //   - 复杂规划：更强的推理模型
    //   - 总结/改写：速度快的通用模型

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
    //
    // max_tokens 只限制"输出 token"，不限制输入 token。
    // 输入 token 来自 messages 里的内容。
    //
    // 总成本通常和两部分有关：
    //   总成本 ≈ 输入 token 价格 + 输出 token 价格
    //
    // 为什么输出 token 经常更贵？
    //   因为生成输出需要模型一步一步推理和采样；
    //   输入主要是读取上下文，输出则是逐 token 生成。
    //
    // 如果 finish_reason 是 "length"：
    //   说明回复被 max_tokens 截断了。
    //   这时不要直接把内容当完整答案使用，应该提高限制、重试或提示用户。

    messages: [
      // messages 数组：存放对话历史
      // 🏠 它就是「通话前递给模型的便签」：模型没有记性，
      //   每次通话都是第一次见你；想让它知道什么（历史对话、背景设定），
      //   就写成一张张便签一起递进去。
      //
      // LLM 没有"记忆"，每次调用都要把历史对话一起发过去
      // 这样 AI 才知道上下文（之前聊了什么）
      //
      // 这个例子只有一条 user 消息，所以它是"单轮调用"。
      //
      // 多轮对话时，messages 可能长这样：
      //   [
      //     { role: "system", content: "你是一个耐心的老师" },
      //     { role: "user", content: "什么是 LLM？" },
      //     { role: "assistant", content: "LLM 是..." },
      //     { role: "user", content: "那 token 又是什么？" }
      //   ]
      //
      // API 不会自动记住上一轮。
      // 如果你想让模型"记得"，就要由应用代码把历史消息再次发送过去。

      {
        role: "user",
        // role：这条消息是谁说的
        // 🏠 role 就是便签上的「落款」，一共三种：
        //   "user" 落款 → 用户（你）
        //   "assistant" 落款 → AI 助手（模型）
        //   "system" 落款 → 系统指令（给 AI 的背景设定，后续课程会讲）
        //
        // 为什么要区分角色？
        //   因为 LLM 是"角色扮演"式工作的
        //   它看到 user 消息，就知道要"回答用户问题"
        //   它看到 assistant 消息，就知道这是"自己之前说的话"
        //
        // system / user / assistant 的简单理解：
        //   system    → 开发者给模型的行为规则："你应该怎么做"
        //   user      → 用户当前提出的任务："你要做什么"
        //   assistant → 模型之前的回复："你刚刚说过什么"
        //
        // 这节课为了保持最简单，只使用 user。
        // 下一节 system-vs-user-prompt 会专门讲 system prompt。

        content:
          "用两句话解释什么是大语言模型（LLM），对象是一个从没接触过AI的程序员。",
        // content：消息的具体内容
        // 这里的提示词（Prompt）很重要，直接影响 AI 的回复质量
        // 好的提示词应该：明确、具体、有上下文
        //
        // 这个 prompt 里其实包含了 3 个约束：
        //   1. 任务：解释什么是大语言模型
        //   2. 长度：用两句话
        //   3. 受众：从没接触过 AI 的程序员
        //
        // 为什么要写受众？
        //   因为同一个概念，对不同人要用不同语言解释。
        //   给程序员可以提到 API、代码、模式匹配；
        //   给小学生可能要用故事或类比；
        //   给 CTO 可能要强调成本、能力边界和业务价值。
      },
    ],
  });

  // ============================================================
  //  读取 OpenAI 的响应结果
  // ============================================================
  //
  // 📤 输入输出走查（response 的真实形状，接住上面 create() 发出的请求）：
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

  // 本节接下来的几行代码，就是照着上面这张"地图"按路径取值：
  //   response.choices[0]           → choice（第一个候选回复）
  //   choice.message.content        → 回复正文（终端打印的就是它）
  //   response.usage.prompt_tokens  → 输入 token 数

  const choice = response.choices[0];
  // response.choices 是一个数组，存放 AI 的所有回复选项
  // 通常我们只请求 1 个回复，所以用 [0] 取第一个
  // 如果你想让 AI 同时生成多个回复做对比，可以设置 n: 2
  //
  // 为什么叫 choices？
  //   因为模型理论上可以一次返回多个候选答案。
  //   例如你可以要求生成 3 个不同版本，然后由代码或人选择一个。
  //
  // 但在大多数 agent 流程里，我们通常只要 1 个结果。
  // 因为多个 choices 会增加成本，也会让后续流程更复杂。

  console.log("GPT 的回复：\n");
  console.log(choice.message.content);
  // choice.message.content 就是 AI 的文字回复
  //
  // 注意：content 可能是 null。
  // 比如当模型决定调用工具时，有些响应里文本内容可能为空，
  // 但会出现 tool_calls 字段。
  //
  // 本例是最简单的文本问答，所以直接打印 content。
  // 真实项目里通常要做更严谨的空值判断。

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
  //
  // 为什么要看 finish_reason？
  //   因为同样拿到了 content，含义可能完全不同：
  //
  //   stop:
  //     大概率是完整回答。
  //
  //   length:
  //     回答被截断，可能句子没说完、JSON 不完整、代码少了结尾。
  //
  //   tool_calls:
  //     模型不是要直接回答，而是在请求你的程序执行某个工具。
  //
  // agent 开发里，一个常见错误是：
  //   只看 content，不看 finish_reason。
  // 这样很容易把半截 JSON、半段计划、未执行的工具调用当成最终结果。
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
  // 这里和 OpenAI 部分使用相同的日志结构。
  //
  // 对比学习时，保持输出格式一致非常重要：
  //   你更容易把注意力放在 SDK 差异上，
  //   而不是被不一样的打印格式分散注意力。

  const response = await anthropicClient.messages.create({
    // Anthropic 的接口是 messages.create（不是 chat.completions.create）
    // 虽然功能一样，但 API 设计风格不同
    // 这就是为什么需要不同的 SDK
    //
    // OpenAI:
    //   openaiClient.chat.completions.create(...)
    //
    // Anthropic:
    //   anthropicClient.messages.create(...)
    //
    // 两者都在做"把消息发给模型，拿回模型回复"。
    // 但方法名、参数细节、返回结构不完全一样。
    //
    // 学 agent 开发时要建立一个重要习惯：
    //   不要凭记忆猜不同供应商的字段名。
    //   换 SDK 时，认真看类型提示和官方文档。

    model: ANTHROPIC_MODEL,
    // Anthropic 的模型名：claude-sonnet-4-20250514、claude-opus-4-20250514 等

    max_tokens: 1024,
    // 跟 OpenAI 一样，限制回复的最大 token 数
    //
    // Anthropic 这里的 max_tokens 也是限制输出长度。
    // 但不同供应商对 token 的计算、上下文窗口、计费方式可能不同。
    //
    // 所以跨模型比较成本时，不能只看 max_tokens 这个数字，
    // 还要看供应商的价格表和实际 response.usage。

    messages: [
      {
        role: "user",
        content:
          "用两句话解释什么是大语言模型（LLM），对象是一个从没接触过AI的程序员。",
        // 用同样的问题，方便对比两个模型的回复风格
        //
        // 这个实验只改变"模型供应商"，不改变 prompt。
        // 这样你看到的差异更可能来自模型本身，而不是提示词变化。
        //
        // 做模型评测时也要遵循这个原则：
        //   尽量一次只改变一个变量。
      },
    ],
  });

  // ============================================================
  //  读取 Anthropic 的响应结果
  // ============================================================
  //
  // 📤 输入输出走查（Anthropic 版，同样以"你好"为例）：
  //   发送：messages.create({
  //           model, max_tokens,
  //           messages: [{ role: "user", content: "你好" }]
  //         })
  //   收到：response —— 答案在 response.content 数组里
  //         type === "text" 的那个块中（注意是数组，不是字符串）
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
  //
  // 为什么要 find，而不是直接 response.content[0]？
  //   因为 content 数组里未来可能不只有 text。
  //   如果第一个元素是 tool_use，直接取 [0].text 就会出错。
  //
  // 这是一种更稳的写法：
  //   先找 type === "text" 的块，
  //   再从文本块里取 text。
  //
  // agent 代码经常要处理这种"联合类型"：
  //   一个数组里可能有文本、工具调用、图片、文件、错误等不同形态。

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
  //
  // 这行看起来有点绕，但它体现了 TypeScript 的一个核心思想：
  //   在运行时可能变化的数据，不能只靠"我觉得它有这个字段"。
  //   要通过判断把类型一步步收窄到安全范围。
  //
  // 对 LLM 响应尤其要这样做。
  // 因为模型响应、工具响应、第三方 API 响应都属于外部输入，
  // 外部输入永远应该被当成"可能不符合预期"来处理。

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
  //
  // 你会发现，同一个概念在不同 SDK 里名字不同：
  //   finish_reason vs stop_reason
  //   prompt_tokens vs input_tokens
  //   completion_tokens vs output_tokens
  //
  // 这就是为什么很多成熟项目会做一层"统一适配器"：
  //   把不同供应商的响应转换成自己项目内部统一的格式。
  //
  // 例如内部统一成：
  //   {
  //     provider: "openai" | "anthropic",
  //     text: string,
  //     inputTokens: number,
  //     outputTokens: number,
  //     stopReason: "stop" | "length" | "tool_call" | "unknown"
  //   }
  //
  // 后续业务代码就不用到处判断供应商差异。
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
  // 📤 输入输出走查（allSettled 的返回值）：
  //   [
  //     { status: "fulfilled", value: undefined },  // callOpenAI 成功
  //     { status: "fulfilled", value: undefined },  // callAnthropic 成功
  //   ]
  //   或者：
  //   [
  //     { status: "fulfilled", value: undefined },  // callOpenAI 成功
  //     { status: "rejected", reason: Error },      // callAnthropic 失败
  //   ]
  //
  // 为什么这里适合用 allSettled？
  //   因为 OpenAI 和 Anthropic 两个演示互相独立。
  //   一个失败，不应该阻止另一个继续展示。
  //
  // 如果这是一个真正的链式任务，比如：
  //   第一步生成标题 → 第二步根据标题写大纲 → 第三步写正文
  // 那就不能简单并行，因为后一步依赖前一步结果。
  //
  // agent 开发里要经常判断：
  //   - 这些步骤是否互相依赖？
  //   - 能不能并行？
  //   - 某一步失败后，整个任务是否还能继续？
  //
  // 这类判断比"会不会调用模型"更接近 agent 工程的核心。

  const results = await Promise.allSettled([callOpenAI(), callAnthropic()]);
  // 注意这里写的是 callOpenAI()，不是 callOpenAI。
  //
  // callOpenAI 表示函数本身，还没有执行。
  // callOpenAI() 才是调用函数，并得到一个 Promise。
  //
  // Promise.allSettled 接收的是 Promise 数组，
  // 所以这里要把两个异步函数都调用起来。

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
      //
      // result.reason?.message || result.reason 的含义：
      //   如果 reason 有 message 字段，就优先打印 message
      //   否则打印整个 reason
      //
      // 为什么要这样写？
      //   有些错误是 Error 对象，有 message；
      //   有些错误可能只是字符串、普通对象或 SDK 自定义错误。
      //
      // 学习阶段打印出来就好。
      // 生产环境一般还会记录：
      //   - 请求 ID
      //   - 模型名
      //   - 供应商
      //   - 错误码
      //   - 是否可重试
      //   - 当前用户或任务 ID
    }
  });
}

// ============================================================
//  第六部分：执行程序
// ============================================================
//
// main() 是 async 函数，返回一个 Promise
// .catch() 用来捕获 main() 中未处理的错误
//
// 📤 输入输出走查（这个程序只有两种结局）：
//   结局 A（一切正常）：main() 完整跑完 → 终端打印两段回复，程序安静退出
//   结局 B（中途出错）：任何未捕获的错误 → 走上面的 .catch 出口收尾，
//     程序不会无声崩溃、也不会带着错误继续往下跑

main().catch(console.error);
// 如果 main() 里的代码抛出了错误，会被 .catch() 捕获
// console.error → 打印错误信息到终端（红色文字）
//
// 等价于：
//   main().catch((error) => console.error(error));
//
// 如果不加 .catch()，未处理的 Promise 错误会打印：
//   "UnhandledPromiseRejectionWarning"（未处理的 Promise 拒绝警告）
//
// 更重要的是：
//   如果入口函数没有 catch，程序可能在你没看清错误原因时直接退出。
//
// agent 程序经常是长流程：
//   读文件 → 调模型 → 调工具 → 再调模型 → 写结果
//
// 任何一步都可能失败。
// 所以从第一课开始就养成习惯：
//   异步入口要有明确的错误出口。

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
//
// ============================================================
//  继续学习时你应该带走的 5 个检查点
// ============================================================
//
// 1. 配置是否正确？
//    - .env 是否存在？
//    - API Key 名称是否和代码一致？
//    - baseURL 是否指向正确服务？
//
// 2. 请求是否清楚？
//    - model 是哪个？
//    - max_tokens 是否足够？
//    - messages 里有哪些 role？
//    - prompt 是否明确说明任务、受众和限制？
//
// 3. 响应是否完整？
//    - content 是否为空？
//    - finish_reason / stop_reason 是否表示正常结束？
//    - usage 是否显示合理的 token 消耗？
//
// 4. 错误是否可理解？
//    - 401/403 多半是鉴权或权限问题
//    - 429 多半是限流或额度问题
//    - 5xx 多半是服务端临时问题
//    - model not found 多半是模型名或供应商配置不匹配
//
// 5. 这个调用在 agent 里扮演什么角色？
//    - 是最终回答？
//    - 是分类/路由？
//    - 是提取结构化信息？
//    - 是生成下一步计划？
//    - 是根据工具结果做总结？
//
// 当你能回答这 5 个问题时，你就不只是在"调一个 API"，
// 而是在理解 agent 系统里最基本、也最重要的工程单元。
