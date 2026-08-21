// ============================================================
//  index_original.ts —— conversation-history 的「原始参考版」
//
//  与 index.ts 的关系：
//  本文件整体被注释保存，是最早的参考实现：每轮都会把 assistant
//  回答 push 回 messages（对话记忆完整）。index.ts 是从它改出来的
//  「失忆实验版」——把保存回答那一行注释掉，专门观察丢上下文的后果；
//  想恢复正常多轮对话，对照下面第 59 行把 index.ts 对应行放开即可。
//  （这里提示词是英文原版，index.ts 换成了中文。）
// ============================================================
//
// // ============================================================
// //  第一课补充：conversation-history（多轮对话历史）
// //
// //  学习目标：
// //  1. 理解模型本身不会“自动记住”上一轮对话
// //  2. 学会把 user/assistant 消息追加到 messages 数组
// //  3. 看懂为什么每次 API 调用都要重新发送必要上下文
// //
// //  核心结论：
// //  Chat API 是“无状态”的。所谓记忆，通常是你的应用代码把历史消息
// //  存起来，并在下一次请求时再次发给模型。
// // ============================================================
//
// import "dotenv/config";
// import OpenAI from "openai";
//
// const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
//
// type Message = OpenAI.ChatCompletionMessageParam;
// // 用 SDK 提供的消息类型可以避免 role/content 写错。
//
// const messages: Message[] = [
//   {
//     role: "system",
//     content:
//       "You are a concise AI engineering tutor. Keep every answer to two sentences.",
//   },
// ];
// // system 消息放在历史最前面，用来设定助手长期遵守的行为风格。
// // 后面每轮会继续往这个数组里 push user 和 assistant 消息。
//
// const userTurns = [
//   "What is an AI agent?",
//   "How is that different from a normal chatbot?",
//   "What should I store if I want the conversation to continue later?",
// ];
// // userTurns 模拟用户连续问三句话。真实聊天应用里，
// // 这些内容会来自输入框，而不是写死在数组里。
//
// async function main() {
//   for (const userTurn of userTurns) {
//     messages.push({ role: "user", content: userTurn });
//     // 先把当前用户问题加入历史，再调用模型。
//     // 如果不 push，模型就看不到这一轮用户到底问了什么。
//
//     console.log("\nUser:");
//     console.log(userTurn);
//     console.log("\nMessages sent to the API:");
//     console.log(messages.map((message) => message.role).join(" -> "));
//
//     const response = await client.chat.completions.create({
//       model: "gpt-4o-mini",
//       max_tokens: 250,
//       messages,
//     });
//
//     const assistantReply = response.choices[0].message.content ?? "";
//
//     messages.push({ role: "assistant", content: assistantReply });
//     // 再把模型回答也加入历史。
//     // 下一轮用户追问“that”或“上面那个”时，模型才有上下文可参考。
//
//     console.log("\nAssistant:");
//     console.log(assistantReply);
//     console.log("\nMessages after appending assistant response:");
//     console.log(messages.map((message) => message.role).join(" -> "));
//     console.log("-".repeat(60));
//   }
// }
//
// main().catch(console.error);
