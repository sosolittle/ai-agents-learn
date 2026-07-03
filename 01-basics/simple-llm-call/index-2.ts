
// ============================================================
//  simple-llm-call 练习版
//
//  这个文件和 index.ts 展示的是同一个核心动作：
//  创建 SDK 客户端 -> 发送 messages -> 读取模型回复。
//
//  学习目标：
//  1. 复习 OpenAI 与 Anthropic 两种 SDK 的最小调用方式
//  2. 对比两家 SDK 返回文本和 token usage 的字段差异
//  3. 练习用 .env 控制 apiKey、baseURL 和 model
//
//  它更像课堂练习/草稿版，所以代码比 index.ts 简短。
//  注释重点放在“为什么要这样写”，详细逐行解释可以参考同目录 index.ts。
// ============================================================

import dotenv from "dotenv";

dotenv.config({override: true})
// override: true 会让当前 .env 覆盖终端里已有的同名环境变量。
// 学习多个 lesson 时，这能减少“明明改了 .env 但没生效”的困惑。

import OpenAI from "openai";

import Anthropic from "@anthropic-ai/sdk";

const openaiClient: OpenAI = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL
})
// OpenAI 客户端。baseURL 可选：不填默认调用 OpenAI 官方地址；
// 填了就可以调用兼容 OpenAI 协议的服务。

const anthropicClient: Anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_AUTH_TOKEN,

    baseURL: process.env.ANTHROPIC_BASE_URL
})
// Anthropic 客户端。它和 OpenAI SDK 的方法名、响应结构都不同，
// 所以同样是“问模型一句话”，下面会有两套读取回复的写法。

const OPENAI_MODEL: string = process.env.ANTHROPIC_MODEL || 'gpt-4o-mini'

const ANTHROPIC_MODEL: string = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4'
// 这里的模型名都来自环境变量并带默认值，方便你在 .env 里切换模型。
// 小提醒：OPENAI_MODEL 当前读取的是 ANTHROPIC_MODEL，可能是练习时留下的笔误；
// 本次只加注释，不改运行逻辑。

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

    const choice = response.choices[0]
    // choices[0] 是第一个候选回复。普通调用通常只有一个 choice。

    console.log('GPT 的回复：\n')
    console.log(choice.message.content)
    console.log('输入 tokens: ', response.usage?.prompt_tokens)
    console.log('输出 tokens: ', response.usage?.completion_tokens)
    console.log("停止原因:     ", choice.finish_reason)
}

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

    const textBlock = response.content.find((block) => block.type === "text")

    const reply = textBlock && "text" in textBlock ? textBlock.text : "(无回复)";
    // 这里做了一个防御式读取：如果没有文本块，就打印“无回复”，避免直接崩溃。

    console.log("Claude 的回复：\n");
    console.log(reply);

    console.log("\n--- Token 使用情况 ---");
    console.log("输入 tokens:  ", response.usage.input_tokens);
    console.log("输出 tokens:  ", response.usage?.output_tokens);
    console.log("停止原因:     ", response.stop_reason);
}

async function main() {
    // const result = await callAnthropic()
    const result = await callOpenAI()
    // 目前只运行 OpenAI 调用；上面保留的 Anthropic 调用注释可用于手动切换练习。
}

main().catch(console.error)





































