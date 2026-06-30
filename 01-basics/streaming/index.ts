// ============================================================
//  第二课：streaming（流式输出）
//  对比非流式和流式两种调用方式，理解"逐字显示"的原理
//
//  学习目标：
//  1. 理解什么是流式输出（Streaming），为什么要用它
//  2. 掌握 stream: true 参数的用法
//  3. 学会用 for await...of 遍历异步可迭代对象
//  4. 理解流式事件的数据结构（delta vs message）
//  5. 区分 process.stdout.write 和 console.log
//
//  前置知识：
//  - 已完成第一课 simple-llm-call
//  - 了解 async/await、Promise 的基本用法
//
//  这一课的核心结论：
//  流式输出不是让模型"总耗时更短"，而是让用户"更早看到内容"。
//
//  非流式调用关注的是：
//    等模型完整生成后，一次性拿到最终结果。
//
//  流式调用关注的是：
//    模型每生成一点，就把这一点交给你的程序处理。
//
//  对 agent 来说，streaming 往往不是推理能力问题，而是产品体验问题：
//    - 用户不用盯着空白页面等待
//    - 长任务可以持续展示进展
//    - 前端可以边接收边渲染
//    - 后端要负责拼接、保存和处理中途错误
// ============================================================

// ============================================================
//  第一部分：导入和初始化
// ============================================================

import "dotenv/config";
// 这是 dotenv 的"副作用导入"写法
// 等价于：import dotenv from "dotenv"; dotenv.config();
// 更简洁，但不能传参数（如 { override: true }）
//
// 什么叫"副作用导入"？
//   有些模块被 import 之后，会自动执行一些初始化逻辑。
//   这里的 "dotenv/config" 被导入后，会自动读取 .env 并写入 process.env。
//
// 它没有导出一个变量给我们使用，所以左边不用写：
//   import xxx from ...
//
// 适合这种一次性初始化的场景。
// 但如果你需要更细的配置，例如 override: true、指定 env 文件路径，
// 就应该改回显式写法：
//   import dotenv from "dotenv";
//   dotenv.config({ override: true });

import OpenAI from "openai";
// OpenAI 官方 SDK
//
// 这节课只演示 OpenAI 的 streaming。
// 不同供应商也支持流式输出，但事件结构、字段名称和结束信号可能不同。
// 学会这个模式后，再看其他 SDK 会更容易。

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
// 创建 OpenAI 客户端
// 这里用简写形式：apiKey: process.env.OPENAI_API_KEY
// 等价于：apiKey: process.env.OPENAI_API_KEY（属性名和变量名相同时可以省略冒号后面的部分）
//
// 这个 client 只是配置好的 SDK 实例。
// 创建它本身通常不会马上发请求。
// 真正发请求发生在下面的 client.chat.completions.create(...)。
//
// 如果 OPENAI_API_KEY 不存在，错误通常会在请求阶段暴露。
// 所以学习时如果报鉴权错误，先检查当前 lesson 目录下的 .env。

// ============================================================
//  第二部分：准备测试用的消息
// ============================================================

const messages = [
  {
    role: "user" as const,
    content:
      "Explain streaming responses in two short paragraphs for a Node developer learning AI APIs.",
    // 用英文提问，因为 GPT 对英文的理解更好
    // 这个问题本身也是在问"什么是流式输出"，一举两得
    //
    // 这个 prompt 包含 3 个关键信息：
    //   1. 主题：streaming responses
    //   2. 长度：two short paragraphs
    //   3. 受众：Node developer learning AI APIs
    //
    // 受众越明确，模型越容易选对解释方式。
    // 给 Node 开发者解释，就可以自然提到 async iterable、stream、事件循环等概念。
  },
];
// as const 的作用：
//   把 role 的类型从 string 收窄为 "user" 这个字面量类型
//   没有 as const：role 的类型是 string（任意字符串）
//   加了 as const：role 的类型是 "user"（只能是 "user" 这个值）
//   这样 TypeScript 可以做更严格的类型检查
//
// 为什么 role 需要这么严格？
//   OpenAI SDK 的消息类型只接受固定的 role：
//     "system" | "user" | "assistant" | "tool" ...
//
// 如果 TypeScript 只看到 string，它会担心你传入 "student"、"admin"、"cat" 之类无效值。
// as const 就是在告诉 TypeScript：
//   这里不是任意字符串，这里就是固定值 "user"。
//
// 这是一种常见的 TypeScript 入门坑：
//   明明运行时值是对的，但类型太宽，编译器不放心。

// ============================================================
//  第三部分：非流式调用（传统方式）
// ============================================================
//
// 先回顾一下上一课学的非流式调用
// 非流式 = 等服务器生成完所有内容，一次性返回给你

async function nonStreamingDemo() {
  console.log("=== 方式一：非流式调用 ===");
  console.log("等待服务器生成完整回复...\n");
  // ↑ 这时候用户只能干等着，看不到任何内容
  // 如果 AI 要生成 500 字，用户可能要等 3-5 秒
  //
  // 非流式的好处：
  //   - 代码简单
  //   - 一次拿到完整结果
  //   - 更容易做 JSON.parse、schema 校验、数据库写入
  //
  // 非流式的缺点：
  //   - 首屏等待时间更长
  //   - 长回答时用户不知道程序是否还活着
  //   - 聊天产品会显得"卡住了"

  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    // 仍然使用便宜、快速的模型，适合学习 streaming 行为。
    // 这里的重点不是模型能力，而是响应方式的差异。

    max_tokens: 300,
    // 限制 300 tokens，让回复不要太长
    //
    // 对 streaming 来说，max_tokens 同样重要：
    //   输出越长，流持续越久；
    //   前端需要保持连接；
    //   后端也要持续处理事件。

    messages,
    // 注意：这里没有 stream: true，所以是默认的非流式模式
    //
    // 默认模式下，SDK 会等服务端完成生成，
    // 然后把完整的 ChatCompletion 对象交给你。
  });

  // 非流式的响应结构（上一课学过）：
  // response = {
  //   choices: [{
  //     message: {
  //       role: "assistant",
  //       content: "完整的回复文本..."  // ← 一次性拿到全部内容
  //     },
  //     finish_reason: "stop"
  //   }],
  //   usage: { ... }
  // }

  console.log("AI 的回复：\n");
  console.log(response.choices[0].message.content);
  // ↑ 一次性打印全部内容
  // 用户体验：等很久 → 突然出现一大段文字
  //
  // 非流式模式适合什么？
  //   - 后台批处理
  //   - 分类、打分、摘要等短任务
  //   - 需要完整 JSON 后再解析的任务
  //   - 不直接面向用户展示生成过程的任务
  //
  // 它不适合什么？
  //   - 聊天窗口里的长回答
  //   - 代码生成这类用户想实时看到进展的任务
  //   - 需要持续反馈"我还在工作"的 agent 流程

  console.log("\n\n");
}

// ============================================================
//  第四部分：流式调用（本课重点）
// ============================================================
//
// 流式 = 服务器每生成一小块内容就立刻发给你，不用等全部生成完
//
// 生活类比：
//   非流式 = 等快递员把所有包裹都打包好，一次性送到你家
//   流式   = 快递员每打包好一个包裹就立刻送过来，你边收边拆
//
// 用户体验对比：
//   非流式：等待 3 秒 → 突然出现一大段文字
//   流式：  等待 0.5 秒 → 逐字出现文字（像打字一样）✅ 更好的体验
//
// 为什么流式更快？
//   不是生成速度变快了，而是"首字节时间"（Time To First Token）变短了
//   用户不需要等全部生成完就能看到第一句话
//
// 换句话说：
//   总生成时间可能差不多，
//   但用户感知到的等待时间明显降低。
//
// 在产品里，这个差异很重要。
// 一个 8 秒后突然出现完整答案的界面，和 0.8 秒开始逐字出现的界面，
// 用户体感完全不同。
//
// 代价是：
//   你的代码要处理"部分结果"。
//   部分结果还不是最终答案，不能随便拿去做 JSON.parse、数据库提交或工具调用。

async function streamingDemo() {
  console.log("=== 方式二：流式调用 ===");
  console.log("逐字打印，边生成边显示...\n");
  // 这里的打印会马上出现。
  // 真正的模型文本会在下面 for await...of 循环里一点点输出。

  const stream = await client.chat.completions.create({
    model: "gpt-4o-mini",
    max_tokens: 300,
    messages,

    stream: true,
    // ↑ 关键区别：加了 stream: true！
    //
    // 加了这个参数后，返回值不再是完整的 response 对象
    // 而是一个"流"（Stream），可以逐个读取小块数据
    //
    // 类型变化：
    //   非流式返回：ChatCompletion（一个完整的对象）
    //   流式返回：  AsyncIterable<ChatCompletionChunk>（一个可异步迭代的对象）
    //
    // AsyncIterable 可以理解成"异步版数组"：
    //   数组里的元素已经全部存在；
    //   AsyncIterable 的元素会随着网络响应陆续到达。
    //
    // 所以你不能像这样读取：
    //   stream.choices[0].message.content
    //
    // 必须通过 for await...of 一块一块读取。
  });

  // ============================================================
  //  核心：用 for await...of 遍历流
  // ============================================================
  //
  // for await...of 是专门用来遍历"异步可迭代对象"的语法
  //
  // 普通的 for...of 遍历同步数据：
  //   for (const item of [1, 2, 3]) { ... }
  //
  // for await...of 遍历异步数据：
  //   for await (const event of stream) { ... }
  //
  // 什么是"异步可迭代对象"？
  //   普通数组：数据已经全部在内存里了，可以立刻遍历
  //   流式数据：数据还没全部到达，每到一小块就触发一次循环体
  //   就像水龙头滴水：每滴一滴，你就处理一滴
  //
  // for await...of 每次循环都会等待下一块数据。
  // 如果下一块还没从网络到达，循环会暂停在这里，
  // 但不会阻塞整个 Node.js 事件循环。
  //
  // 这也是为什么它适合处理：
  //   - 网络流
  //   - 文件流
  //   - 数据库游标
  //   - LLM streaming events

  let chunkCount = 0;
  // 用来计数：收到了多少个数据块
  //
  // 注意：
  //   chunk 数量不等于 token 数量，也不等于字符数量。
  //   一个 chunk 里可能有一个字、几个字、一个空字符串，甚至没有文本。
  //
  // 这里的 chunkCount 只是帮助你感受"流被分成了多少次到达"。

  let fullResponse = "";
  // 用来拼接：把所有小块合并成完整回复
  //
  // 为什么要拼接完整回复？
  //   因为 UI 可以边显示边更新，
  //   但业务系统通常还需要在结束后保存完整 assistant 消息。
  //
  // 例如聊天应用里：
  //   1. 前端实时显示 token
  //   2. 后端把 token 拼成完整回复
  //   3. 流结束后，把完整回复写入数据库
  //   4. 下一轮对话再把这条 assistant 消息放回 messages

  for await (const event of stream) {
    // ↑ 每次循环，event 是一个 ChatCompletionChunk 对象
    // 这个对象是服务器发来的"一小块数据"
    //
    // 流式事件的结构（跟非流式不同！）：
    // event = {
    //   id: "chatcmpl-abc123",
    //   choices: [{
    //     index: 0,
    //     delta: {                    // ← 注意是 delta，不是 message！
    //       role: "assistant",
    //       content: "你"             // ← 只有一个字或几个字，不是完整句子
    //     },
    //     finish_reason: null         // 还没结束时是 null
    //   }]
    // }
    //
    // ⚠️ 关键区别：
    //   非流式：response.choices[0].message.content → 完整文本
    //   流式：  event.choices[0].delta.content       → 一小块文本（可能为空）
    //
    // delta 这个名字很重要。
    // delta 的意思是"增量"：
    //   这一次事件只告诉你"新增了什么"，
    //   而不是给你完整答案。
    //
    // 所以 streaming 的核心工程任务就是：
    //   不断接收 delta，
    //   实时展示 delta，
    //   同时把 delta 拼回完整 message。

    const token = event.choices[0]?.delta?.content;
    // ↑ 从流式事件中提取文本片段
    //
    // 逐层拆解：
    //   event.choices[0]  → 取第一个 choice（跟非流式一样）
    //   ?.delta           → 用可选链访问 delta（有些事件没有 delta）
    //   ?.content         → 再用可选链访问 content（有些 delta 没有 content）
    //
    // 为什么用 ?. 可选链？
    //   流式事件中，不是每个 event 都有文本内容！
    //   有些 event 只包含元数据（如模型名、usage 统计等）
    //   如果不用 ?.，访问不存在的属性会报错
    //
    // 在流式系统里，"没有内容"不一定是错误。
    // 它可能只是一个结构事件、结束事件或元数据事件。
    //
    // 所以代码要区分：
    //   - 没有 token：跳过
    //   - 有 token：展示并拼接
    //   - 抛异常：进入错误处理

    if (token) {
      // 只有当 token 存在（不是 undefined）时才处理
      //
      // 什么时候 token 会是 undefined？
      //   1. 流刚开始时，第一个 event 可能只有 role 信息，没有 content
      //   2. 流结束时，最后一个 event 可能只有 finish_reason，没有 content
      //   3. 某些中间 event 可能是空的（服务器心跳包）

      process.stdout.write(token);
      // ↑ process.stdout.write 和 console.log 的区别：
      //
      // console.log("hello"):
      //   输出 "hello" + 自动换行
      //   适合：打印日志、调试信息
      //
      // process.stdout.write("hello"):
      //   只输出 "hello"，不换行
      //   适合：逐字打印、进度条、动态更新
      //
      // 如果用 console.log，每个 token 都会换行：
      //   你
      //   好
      //   ，
      //   世
      //   界
      // 用 process.stdout.write，效果是：
      //   你好，世界  （在同一行逐字出现）
      //
      // 在真实 Web 应用里，这一步通常不是写 stdout，
      // 而是把 token 推送给前端：
      //   - Server-Sent Events（SSE）
      //   - WebSocket
      //   - HTTP streaming response
      //
      // 命令行用 stdout.write，是最小可运行版本。

      fullResponse += token;
      // 把 token 拼接到完整回复中
      // 等流结束后，fullResponse 就是完整的 AI 回复
      //
      // 注意字符串拼接适合这个小例子。
      // 如果你处理非常长的输出，也可以收集到数组里：
      //   const parts: string[] = [];
      //   parts.push(token);
      //   const fullResponse = parts.join("");
      //
      // 这样在极长文本场景下可能更高效。

      chunkCount++;
    }

    // 最后一个 event 的 finish_reason 会变成 "stop"
    // 表示 AI 已经说完了
    // 你也可以用它来判断流是否结束：
    //   const reason = event.choices[0]?.finish_reason;
    //   if (reason === "stop") { console.log("流结束了"); }
    //
    // finish_reason 也可能是 "length"：
    //   说明达到了 max_tokens，回答被截断。
    //
    // 如果你在生成 JSON、代码或 Markdown 表格，
    // 截断可能导致结果不完整。
    //
    // 所以真实项目里通常会记录最终 finish_reason，
    // 并在 length 时提示用户或自动续写。
  }

  // 流结束后打印统计信息
  process.stdout.write("\n\n");
  // ↑ 手动加一个换行，因为上面的 process.stdout.write 不会自动换行

  console.log("--- 流式输出统计 ---");
  console.log(`共收到 ${chunkCount} 个数据块`);
  console.log(`完整回复长度：${fullResponse.length} 个字符`);
  // ↑ 模板字符串（Template Literal）：用反引号包裹，${} 插入变量
  //
  // 这里统计的是字符长度，不是 token 数。
  // token 是模型内部的文本切分单位，字符是 JavaScript 字符串长度。
  //
  // 两者不要混淆：
  //   - 成本和模型上下文看 token
  //   - 前端显示和字符串处理常看字符
  //
  // 如果要看真实 token 使用量，需要读取 API 返回的 usage。
  // 流式场景下 usage 的获取方式可能和非流式略有不同，
  // 具体要看 SDK 和接口参数支持。
}

// ============================================================
//  第五部分：运行入口
// ============================================================

async function main() {
  // 先运行非流式，再运行流式，方便对比
  await nonStreamingDemo();
  await streamingDemo();
  //
  // 这里两个 await 是顺序执行：
  //   先完整展示非流式效果，
  //   再展示流式效果。
  //
  // 这比并行更慢一点，但更适合教学。

  // 注意：这里用的是串行执行（一个完了才开始下一个）
  // 而不是 Promise.allSettled 并行
  // 为什么？因为我们要在终端里清楚地看到两种方式的输出差异
  // 如果并行，输出会混在一起，看不清楚
}

main().catch(console.error);
// 捕获 main() 中没有被单独处理的错误
//
// 流式调用也可能报错：
//   - 请求刚开始就失败：比如 API Key 错误
//   - 流进行到一半失败：比如网络断开
//
// 这个例子用最简单的 .catch(console.error)。
// 生产项目通常需要更细的错误处理：
//   - 通知前端流已中断
//   - 保存已经生成的部分内容
//   - 标记消息状态为 failed / interrupted
//   - 提供重试按钮

// ============================================================
//  总结：非流式 vs 流式对比
// ============================================================
//
// | 对比项         | 非流式                        | 流式                          |
// |---------------|-------------------------------|-------------------------------|
// | 参数          | 不加 stream（默认）            | stream: true                  |
// | 返回值        | ChatCompletion（完整对象）     | AsyncIterable（可迭代流）      |
// | 取文本        | response.choices[0].message.content | event.choices[0].delta.content |
// | 文本长度      | 完整的一段话                   | 每次只有几个字                 |
// | 遍历方式      | 直接访问属性                   | for await...of 循环           |
// | 用户体验      | 等很久 → 突然出现              | 边等边出 → 像打字一样          |
// | 适用场景      | 后端处理、批量任务             | 聊天界面、实时展示              |
// | 错误处理      | try/catch 一次                 | 流中途也可能出错，需要额外处理   |
//
// 流式输出在 Agent 开发中的应用：
//   1. 聊天界面：用户发消息后，AI 的回复逐字出现（像 ChatGPT）
//   2. 长文本生成：写文章、写代码时，边生成边显示进度
//   3. 工具调用：Agent 在思考时，给用户显示"正在分析..."
//   4. 实时翻译：边听边译，不用等整段话说完
//
// 真实 agent 里还要注意：
//   1. 不要把未完成的流式文本当作最终结果
//   2. 如果要保存对话，流结束后保存 fullResponse
//   3. 如果流中断，要决定保留部分结果还是丢弃
//   4. 前端展示 token 时，后端仍要维护完整状态
//   5. 流式输出改善体验，但不会替代输出校验
//
// 最重要的一句话：
//   streaming 是"增量传输"，不是"增量真相"。
//   只有流结束，并确认 finish_reason 正常后，结果才更适合进入下一步业务逻辑。
//
// 下一步学习：
//   - 01-basics/conversation-history → 多轮对话管理
//   - 01-basics/system-vs-user-prompt → 系统提示词的作用
//   - 02-tool-use → 让 AI 调用工具（函数调用）
