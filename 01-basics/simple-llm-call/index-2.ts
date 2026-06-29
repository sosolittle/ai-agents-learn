
import dotenv from "dotenv";

dotenv.config({override: true})

import OpenAI from "openai";

import Anthropic from "@anthropic-ai/sdk";

const openaiClient: OpenAI = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL
})

const anthropicClient: Anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_AUTH_TOKEN,

    baseURL: process.env.ANTHROPIC_BASE_URL
})

const OPENAI_MODEL: string = process.env.ANTHROPIC_MODEL || 'gpt-4o-mini'

const ANTHROPIC_MODEL: string = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4'

async function callOpenAI() {
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

    console.log('GPT 的回复：\n')
    console.log(choice.message.content)
    console.log('输入 tokens: ', response.usage?.prompt_tokens)
    console.log('输出 tokens: ', response.usage?.completion_tokens)
    console.log("停止原因:     ", choice.finish_reason)
}

async function callAnthropic() {
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
}

main().catch(console.error)







































