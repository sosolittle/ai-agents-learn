
// ============================================================
//  streaming 练习版
//
//  这个文件用较短代码对比：
//  - 非流式：等完整回复生成完再一次性打印
//  - 流式：边生成边收到 chunk，边打印到终端
//
//  学习目标：
//  1. 用最短代码看懂 stream: true 的效果
//  2. 练习 for await...of 读取流式事件
//  3. 理解 delta.content 和完整 message.content 的区别
//
//  如果想看更完整的教学注释，请读同目录 index.ts。
// ============================================================

import dotenv from "dotenv"
import OpenAI from "openai"
import Anthropic from "@anthropic-ai/sdk";

dotenv.config({override: true})
// 显式加载 .env。override: true 方便课程之间切换环境变量。

const openaiClient = new OpenAI({
    baseURL: process.env.OPENAI_BASE_URL,
    apiKey: process.env.OPENAI_API_KEY
})
// 这个客户端既可以连 OpenAI 官方接口，也可以通过 baseURL 连兼容接口。

const OPENAI_MODEL: string = process.env.ANTHROPIC_MODEL || 'gpt-4o-mini'
// 小提醒：这里读取的是 ANTHROPIC_MODEL，可能是练习中的笔误；
// 本次任务只补注释，不改变代码行为。

const messages = [
    {
        role: "user" as const,
        content: "什么是流式输出？"
    }
]
// messages 是发给模型的对话上下文。这里只有一条 user 消息，
// 所以它是最小的单轮调用示例。

async function nonStreamingDemo() {
    // 非流式调用：await 会一直等到服务器把完整回答生成完。
    console.log("=== 方式一：非流式调用 ===");
    console.log("等待服务器生成完整回复...\n");
    const response = await openaiClient.chat.completions.create({
        model: OPENAI_MODEL,
        messages: messages,
        max_completion_tokens: 1024
    })
    console.log("AI 的回复：\n");
    console.log(response.choices[0].message.content);
    console.log("\n\n");
}

async function streamingDemo() {
    // 流式调用：加上 stream: true 后，返回值变成一个异步可迭代对象。
    // 你可以用 for await...of 一段一段读取模型生成的内容。
    console.log("=== 方式二：流式调用 ===");
    console.log("逐字打印，边生成边显示...\n");
    const stream = await openaiClient.chat.completions.create({
        model: OPENAI_MODEL,
        messages: messages,
        max_completion_tokens: 1024,
        stream: true
    })

    let chunkCount = 0

    let fullResponse = ""
    // 流式输出时，终端可以边打印 token；
    // 但如果后面还要保存完整回答，就需要像这样自己拼起来。

    for await (const event of stream) {
        const token = event.choices[0]?.delta?.content
        // delta 表示“这一次新增加的内容片段”。
        // 非流式响应里读 message.content；流式响应里通常读 delta.content。
        if (token) {
            process.stdout.write(token)
            // process.stdout.write 不会自动换行，适合模拟聊天窗口逐字出现的效果。
            fullResponse += token
            chunkCount++
        }
    }

    process.stdout.write("\n\n");

    console.log("--- 流式输出统计 ---");
    console.log(`共收到 ${chunkCount} 个数据块`);
    console.log(`完整回复长度：${fullResponse.length} 个字符`);
}

async function main() {
    await nonStreamingDemo()
    await streamingDemo()
    // 先非流式、再流式，方便你直观看到两种用户体验的差异。
}

main().catch(console.error)

















// const anthropicClient = new Anthropic({
//     baseURL: process.env.ANTHROPIC_BASE_URL,
//     apiKey: process.env.ANTHROPIC_AUTH_TOKEN,
// })
// 保留的 Anthropic 客户端草稿：以后可以用来对比不同 SDK 的 streaming 写法。
