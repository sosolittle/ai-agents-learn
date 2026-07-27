// ============================================================
//  第一课补充：conversation-history（多轮对话历史）
//
//  学习目标：
//  1. 理解模型本身不会“自动记住”上一轮对话
//  2. 学会把 user/assistant 消息追加到 messages 数组
//  3. 看懂为什么每次 API 调用都要重新发送必要上下文
//
//  核心结论：
//  Chat API 是“无状态”的。所谓记忆，通常是你的应用代码把历史消息
//  存起来，并在下一次请求时再次发给模型。
// ============================================================

import "dotenv/config";
import OpenAI from "openai";
import client from "./src/openai-charles-client";

// const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

type Message = OpenAI.ChatCompletionMessageParam;
// 用 SDK 提供的消息类型可以避免 role/content 写错。

const messages: Message[] = [
  {
    role: "system",
    content:
      "你是一位简洁的 AI 工程导师。每次回答不超过两句话。",
  },
];
// system 消息放在历史最前面，用来设定助手长期遵守的行为风格。
// 后面每轮会继续往这个数组里 push user 和 assistant 消息。

const userTurns = [
  "什么是 AI 智能体？",
  "它和普通聊天机器人有什么区别？",
  "如果我想以后继续这段对话，应该保存哪些内容？",
  "你能给我举一个具体的例子吗？",
];
// userTurns 模拟用户连续问四句话。真实聊天应用里，
// 这些内容会来自输入框，而不是写死在数组里。

async function main() {
  for (const userTurn of userTurns) {
    messages.push({ role: "user", content: userTurn });
    // 先把当前用户问题加入历史，再调用模型。
    // 如果不 push，模型就看不到这一轮用户到底问了什么。

    console.log("\n用户：");
    console.log(userTurn);
    console.log("\n发送给 API 的消息：");
    console.log(messages.map((message) => message.role).join(" -> "));

    const response = await client.chat.completions.create({
      model: model,
      max_tokens: 500,
      messages,
    });

    const assistantReply = response.choices[0].message.content ?? "";

    // 实验：暂时不把模型回答加入历史，观察后续回答会失去哪些上下文。
    // messages.push({ role: "assistant", content: assistantReply });

    console.log("\n助手：");
    console.log(assistantReply);
    // console.log("\n保存助手回答时的消息：");
    console.log("\n未保存助手回答时的消息：");
    console.log(messages.map((message) => message.role).join(" -> "));
    console.log("当前消息数量：", messages.length);
    console.log("-".repeat(60));
  }
}

main().catch(console.error);
