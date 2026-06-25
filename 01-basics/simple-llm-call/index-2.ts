
import dotenv from "dotenv";

dotenv.config({override: true})

import OpenAI, {ChatCompletion} from "openai";

import Anthropic from "@anthropic-ai/sdk";

const openaiClient: OpenAI = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
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
}