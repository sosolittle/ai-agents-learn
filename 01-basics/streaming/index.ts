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
// ============================================================

// ============================================================
//  第一部分：导入和初始化
// ============================================================

import "dotenv/config";
// 这是 dotenv 的"副作用导入"写法
// 等价于：import dotenv from "dotenv"; dotenv.config();
// 更简洁，但不能传参数（如 { override: true }）

import OpenAI from "openai";
// OpenAI 官方 SDK

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
// 创建 OpenAI 客户端
// 这里用简写形式：apiKey: process.env.OPENAI_API_KEY
// 等价于：apiKey: process.env.OPENAI_API_KEY（属性名和变量名相同时可以省略冒号后面的部分）

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
  },
];
// as const 的作用：
//   把 role 的类型从 string 收窄为 "user" 这个字面量类型
//   没有 as const：role 的类型是 string（任意字符串）
//   加了 as const：role 的类型是 "user"（只能是 "user" 这个值）
//   这样 TypeScript 可以做更严格的类型检查

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

  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    max_tokens: 300,
    // 限制 300 tokens，让回复不要太长

    messages,
    // 注意：这里没有 stream: true，所以是默认的非流式模式
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

async function streamingDemo() {
  console.log("=== 方式二：流式调用 ===");
  console.log("逐字打印，边生成边显示...\n");

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

  let chunkCount = 0;
  // 用来计数：收到了多少个数据块

  let fullResponse = "";
  // 用来拼接：把所有小块合并成完整回复

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

      fullResponse += token;
      // 把 token 拼接到完整回复中
      // 等流结束后，fullResponse 就是完整的 AI 回复

      chunkCount++;
    }

    // 最后一个 event 的 finish_reason 会变成 "stop"
    // 表示 AI 已经说完了
    // 你也可以用它来判断流是否结束：
    //   const reason = event.choices[0]?.finish_reason;
    //   if (reason === "stop") { console.log("流结束了"); }
  }

  // 流结束后打印统计信息
  process.stdout.write("\n\n");
  // ↑ 手动加一个换行，因为上面的 process.stdout.write 不会自动换行

  console.log("--- 流式输出统计 ---");
  console.log(`共收到 ${chunkCount} 个数据块`);
  console.log(`完整回复长度：${fullResponse.length} 个字符`);
  // ↑ 模板字符串（Template Literal）：用反引号包裹，${} 插入变量
}

// ============================================================
//  第五部分：运行入口
// ============================================================

async function main() {
  // 先运行非流式，再运行流式，方便对比
  await nonStreamingDemo();
  await streamingDemo();

  // 注意：这里用的是串行执行（一个完了才开始下一个）
  // 而不是 Promise.allSettled 并行
  // 为什么？因为我们要在终端里清楚地看到两种方式的输出差异
  // 如果并行，输出会混在一起，看不清楚
}

main().catch(console.error);

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
// 下一步学习：
//   - 01-basics/conversation-history → 多轮对话管理
//   - 01-basics/system-vs-user-prompt → 系统提示词的作用
//   - 02-tool-use → 让 AI 调用工具（函数调用）
