
import dotenv from "dotenv"
import OpenAI from "openai"
import Anthropic from "@anthropic-ai/sdk";

dotenv.config({override: true})

const openaiClient = new OpenAI({
    baseURL: process.env.OPENAI_BASE_URL,
    apiKey: process.env.OPENAI_API_KEY
})

const OPENAI_MODEL: string = process.env.ANTHROPIC_MODEL || 'gpt-4o-mini'

const messages = [
    {
        role: "user" as const,
        content: "什么是流式输出？"
    }
]

async function nonStreamingDemo() {
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

    for await (const event of stream) {
        const token = event.choices[0]?.delta?.content
        if (token) {
            process.stdout.write(token)
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
}

main().catch(console.error)

















// const anthropicClient = new Anthropic({
//     baseURL: process.env.ANTHROPIC_BASE_URL,
//     apiKey: process.env.ANTHROPIC_AUTH_TOKEN,
// })