// ============================================================
//  第一课补充：conversation-history（多轮对话历史）
//
//  🏠 生活化比喻：
//  模型 = 每次 API 调用都是「新上岗的客服」：换班之后，
//  上一通电话聊了什么一点不记得——不是它笨，是接线机制本来如此。
//  messages 数组 = 每次通话前，把完整聊天记录打印出来递给客服看。
//  所以「多轮对话的记忆」不是模型的能力，而是应用代码的功劳：
//  你把历史存下来，每次请求原样重发一遍。
//
//  学习目标：
//  1. 理解模型本身不会“自动记住”上一轮对话
//  2. 学会把 user/assistant 消息追加到 messages 数组
//  3. 看懂为什么每次 API 调用都要重新发送必要上下文
//
//  核心结论：
//  Chat API 是“无状态”的。所谓记忆，通常是你的应用代码把历史消息
//  存起来，并在下一次请求时再次发给模型。
//
//  ⚠️ 本文件正处于「失忆实验」状态：main() 里把「保存助手回答」
//  注释掉了（见下方实验区）——messages 里只有 user 问题、没有
//  assistant 回答。跑完对比 index_original.ts（正常保存版）的输出，
//  丢上下文的后果比读十篇教程都直观。
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
// 记住：这个数组就是模型的「全部世界」——它每次只能看到
// 你递过去的这些纸条，数组之外的任何东西它都不知道。

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
    //
    // 📤 输入输出走查（第二轮对话的两种命运）：
    //   正常保存时（index_original.ts 的做法）：
    //     [system, user:"什么是 AI 智能体？", assistant:"（第一轮回答）",
    //      user:"它和普通聊天机器人有什么区别？"]
    //     → 中间隔着一条 assistant，模型知道「它」= 智能体，答得连贯
    //   不保存时（本文件当前的实验状态）：
    //     [system, user:"什么是 AI 智能体？",
    //      user:"它和普通聊天机器人有什么区别？"]
    //     → 两条 user 挤在一起，「它」指什么只能靠猜，回答开始跑偏

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
