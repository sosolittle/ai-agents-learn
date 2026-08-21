
// ============================================================
//  第一课练习版：simple-llm-call（index-2）
//
//  🏠 生活化比喻：
//  如果 index.ts 是「老师带你逐行精讲的教科书」，
//  这个文件就是「课后自己再炒一遍的同一道菜」：
//  食材完全一样（SDK 总机 → 递便签 → 读回执），
//  只是做法更精简，留给你自己动手切换、观察的空间。
//
//  它和 index.ts 的关系（变体/练习，核心动作相同）：
//  - index.ts：逐行详解版，main() 并行跑 OpenAI + Anthropic 两个演示
//  - 本文件：精简练习版，main() 默认只跑 OpenAI（Anthropic 那行
//    被注释保留着，就是要你手动切换再跑一遍）
//  - 顺带差异：这里的客户端/模型名写了显式类型标注（OpenAI、string），
//    可以对比一下"写与不写类型"两种风格
//
//  学习目标：
//  1. 复习 OpenAI 与 Anthropic 两种 SDK 的最小调用方式
//  2. 对比两家 SDK 返回文本和 token usage 的字段差异
//  3. 练习用 .env 控制 apiKey、baseURL 和 model
//
//  核心结论：
//  把注释全部忽略掉你会发现：调一次 LLM 的骨架只有四步——
//  建客户端 → 放便签（messages）→ await 调用 → 按路径取 content。
//  记住这个骨架，比记住任何一家 SDK 的字段名更重要，
//  因为换一家供应商时字段名会变，骨架永远不变。
//
//  注释重点放在“为什么要这样写”，逐行详解可参考同目录 index.ts。
// ============================================================

// ============================================================
//  第一段：导入包 + 加载 .env 配置
// ============================================================
// 三个包各司其职（比喻在 index.ts 已展开，这里一句话带过）：
//   dotenv = 把 .env 里的配置搬进 process.env 的搬运工
//   openai / @anthropic-ai/sdk = 两家模型的「官方电话总机」

import dotenv from "dotenv";

dotenv.config({override: true})
// override: true 会让当前 .env 覆盖终端里已有的同名环境变量。
// 学习多个 lesson 时，这能减少“明明改了 .env 但没生效”的困惑。

import OpenAI from "openai";

import Anthropic from "@anthropic-ai/sdk";

// ============================================================
//  第二段：创建两个客户端 + 读取模型名
// ============================================================
// 客户端 = 在总机那头「登记好工牌（apiKey）和分机地址（baseURL）」后
// 拿到的一条专线：后面每次 create() 都是沿着这条线跟模型通话。
// 注意：登记这一步不发网络请求，真正"打电话"是 create() 执行的时候。

const openaiClient: OpenAI = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL
})
// OpenAI 客户端。baseURL 可选：不填默认调用 OpenAI 官方地址；
// 填了就可以调用兼容 OpenAI 协议的服务。
//
// 📤 输入输出走查（baseURL 是怎么切换服务商的）：
//   .env 不写 OPENAI_BASE_URL → 请求发往 https://api.openai.com/v1
//   .env 写 OPENAI_BASE_URL=https://api.deepseek.com/v1
//                              → 同一段代码改打 DeepSeek，只动配置不动代码

const anthropicClient: Anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_AUTH_TOKEN,

    baseURL: process.env.ANTHROPIC_BASE_URL
})
// Anthropic 客户端。它和 OpenAI SDK 的方法名、响应结构都不同，
// 所以同样是“问模型一句话”，下面会有两套读取回复的写法。

const OPENAI_MODEL: string = process.env.ANTHROPIC_MODEL || 'gpt-4o-mini'

const ANTHROPIC_MODEL: string = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4'
// 模型名都来自环境变量并带默认值：改 .env 就能换模型，不用动代码。
//
// ⚠️ 高危易错点：上面 OPENAI_MODEL 那一行读的却是 ANTHROPIC_MODEL！
//   就像拿着 A 栋的门牌去 B 栋取钥匙：如果你只在 .env 里设了 OPENAI_MODEL，
//   这一行根本读不到，会静默落到默认值 'gpt-4o-mini'，而且不报任何错。
//   这多半是练习时留下的笔误；本次只加注释，不改运行逻辑——
//   你可以把它当成第一个"找 bug"练习：
//   想想在 main() 里加一行 console.log(OPENAI_MODEL) 能验证什么。

// ============================================================
//  第三段：练习一 —— OpenAI 最小调用
// ============================================================
// 和 index.ts 相比省略了 max_tokens（不传时用服务端默认值），
// 目的是把一次调用压到最短骨架：一行 create + 两行取值。

async function callOpenAI() {
    // OpenAI Chat Completions 的典型路径：
    // client.chat.completions.create({ model, messages })
    console.log('='.repeat(50))
    console.log('方式一：OpenAI SDK 调用 GPT 模型')
    console.log('='.repeat(50))

    const response = await openaiClient.chat.completions.create({
        model: OPENAI_MODEL,
        messages: [{
            role: 'user',
            content: '用两句话解释什么是大语言模型（LLM），对象是一个从没接触过AI的程序员。'
        }]
    })

    // 📤 输入输出走查（这一次调用，进出分别长什么样）：
    //   发送出去的请求体：
    //     {
    //       model: "gpt-4o-mini",
    //       messages: [{ role: "user", content: "用两句话解释…大语言模型…" }]
    //     }
    //   收回来的响应（简化后的真实形状）：
    //     {
    //       choices: [{
    //         index: 0,
    //         message: { role: "assistant", content: "大语言模型是一种…" },
    //         finish_reason: "stop"
    //       }],
    //       usage: { prompt_tokens: 34, completion_tokens: 48, total_tokens: 82 }
    //     }
    //   接下来两行，就是沿着 choices[0] → message.content 这条路把正文剥出来。

    const choice = response.choices[0]
    // choices[0] 是第一个候选回复。普通调用通常只有一个 choice。

    console.log('GPT 的回复：\n')
    console.log(choice.message.content)
    // usage 就是这次调用的「账单明细」：
    // 输入按 prompt_tokens 计费，输出按 completion_tokens 计费（通常更贵）。
    console.log('输入 tokens: ', response.usage?.prompt_tokens)
    console.log('输出 tokens: ', response.usage?.completion_tokens)
    console.log("停止原因:     ", choice.finish_reason)
}

// ============================================================
//  第四段：练习二 —— Anthropic 最小调用（main 默认不跑它）
// ============================================================
// 同一句问题、另一家总机：重点观察"读取回复"的写法哪里不一样。

async function callAnthropic() {
    // Anthropic Messages API 的返回结构和 OpenAI 不同：
    // response.content 是一个 block 数组，需要找到 type === "text" 的块。
    console.log("\n" + "=".repeat(50));
    console.log("方式二：Anthropic SDK 调用 Claude 模型");
    console.log("=".repeat(50) + "\n");

    const response = await anthropicClient.messages.create({
        model: ANTHROPIC_MODEL,
        max_tokens: 1024,
        messages: [{
            role: "user",
            content: "用两句话解释什么是大语言模型（LLM），对象是一个从没接触过AI的程序员。"
        }]
    })

    // 📤 输入输出走查（为什么需要 find 这一步）：
    //   OpenAI    的回复正文：choice.message.content → 直接是字符串
    //   Anthropic 的回复正文：response.content → 是一个「内容块」数组，例如
    //     [ { type: "text", text: "大语言模型是…" } ]
    //   find(block => block.type === "text") 就是从这叠块里抽出「文字那一页」，
    //   即使以后块里混进别的类型（比如 tool_use——表示模型想调用外部工具，
    //   后续课程才会遇到的块类型），也不怕取错。

    const textBlock = response.content.find((block) => block.type === "text")

    const reply = textBlock && "text" in textBlock ? textBlock.text : "(无回复)";
    // 这里做了一个防御式读取：如果没有文本块，就打印“无回复”，避免直接崩溃。

    console.log("Claude 的回复：\n");
    console.log(reply);

    console.log("\n--- Token 使用情况 ---");
    // 小观察：input_tokens 前没写 ?.，output_tokens 前写了——
    // usage 存在时两种写法结果一样；差异只在 usage 缺失时会不会崩。
    console.log("输入 tokens:  ", response.usage.input_tokens);
    console.log("输出 tokens:  ", response.usage?.output_tokens);
    console.log("停止原因:     ", response.stop_reason);
}

// ============================================================
//  第五段：运行入口 —— 一次只跑一条线，方便单独观察
// ============================================================
async function main() {
    // const result = await callAnthropic()
    const result = await callOpenAI()
    // 目前只运行 OpenAI 调用。上面那行被注释的代码是刻意保留的「开关」：
    // 注释掉 callOpenAI()、放开 callAnthropic()，就切换成跑 Anthropic 版。
    //
    // ⚠️ 易错点：不能直接把两行都放开！
    //   两行都写着 const result = ...，同一个作用域里重复声明 result，
    //   JS/TS 会直接抛 SyntaxError:
    //   "Identifier 'result' has already been declared"——程序根本跑不起来。
    //   想两个都跑：删掉其中一个的 const result =（直接写 await callXxx()），
    //   或者给第二个换个变量名（如 result2）。
    //   重复声明是初学 JS/TS 的经典坑，见到这条报错就能立刻对上号。
}

// 异步入口的最后一道兜底：main() 里没被捕获的错误都会在这里红字打印，
// 而不是让程序悄无声息地崩掉。
main().catch(console.error)





































