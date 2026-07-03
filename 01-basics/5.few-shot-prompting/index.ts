// ============================================================
//  第一课补充：few-shot-prompting（少样本提示）
//
//  学习目标：
//  1. 理解 zero-shot 和 few-shot 的区别
//  2. 观察“规则 + 示例”如何影响模型分类结果
//  3. 学会用低 temperature 做稳定分类任务
//
//  核心概念：
//  - Zero-shot：只给规则，不给示例，让模型直接完成任务。
//  - Few-shot：除了规则，还给几组“输入 -> 正确输出”的示范。
//
//  对初学者来说，可以把 few-shot 理解成“给模型看几道例题”。
//  当分类边界容易混淆时，示例通常比单纯写规则更直观。
// ============================================================

import "dotenv/config";
import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
// client 是和 OpenAI API 通信的客户端。这里使用 dotenv/config，
// Node 启动时会自动读取 .env，把 OPENAI_API_KEY 放进 process.env。

const labels = ["billing", "technical", "sales", "general"] as const;
// as const 会把数组元素固定为字面量类型，而不是普通 string。
// 这样 TypeScript 知道 labels 只能是这四个具体分类。

const rules = `Classify customer support messages as one of: ${labels.join(", ")}.

Rules:
- If a message mentions charge, refund, invoice, payment, or subscription cancellation, classify as billing even if it also mentions API/app issues.
- If it mainly reports a bug, crash, webhook, API failure, or broken upload without money impact, classify as technical.
- If it asks about pricing, onboarding, demos, or plan options before purchase, classify as sales.
- Otherwise classify as general.

Return only the label.`;
// rules 是分类任务的“评分标准”。真实客服场景里，规则越清楚，
// 模型越不容易把“退款 + 技术故障”这种混合问题分错类。

const inputs = [
  "I was charged twice after the webhook failed.",
  "The dashboard crashes whenever I upload a CSV.",
  "Do you offer onboarding calls for new teams?",
  "I want to cancel because the API keeps timing out.",
];
// inputs 是要测试的客户消息。它们故意包含一些容易混淆的情况，
// 比如既提到 webhook/API，又提到 charged/cancel。

async function classifyZeroShot(message: string) {
  // Zero-shot 版本：只把规则和当前消息发给模型，不提供任何示例。
  // 这能测试“规则本身”是否足够清晰。
  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    max_tokens: 20,
    temperature: 0,
    // temperature: 0 让输出尽量稳定。分类任务通常希望可重复，
    // 不希望同一条工单这次是 billing、下次变成 technical。
    messages: [
      {
        role: "user",
        content: `${rules}\n\nMessage: ${message}`,
      },
    ],
  });

  return response.choices[0].message.content ?? "";
}

async function classifyFewShot(message: string) {
  // Few-shot 版本：先提供几组完整示例，再让模型分类新的 message。
  // 示例的作用不是“存数据库”，而是临时放进上下文里给模型模仿。
  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    max_tokens: 20,
    temperature: 0,
    messages: [
      { role: "system", content: rules },
      {
        role: "user",
        content: "The API failed and then I got charged for the retry.",
      },
      { role: "assistant", content: "billing" },
      {
        role: "user",
        content: "The webhook returns 500 when I send test events.",
      },
      { role: "assistant", content: "technical" },
      {
        role: "user",
        content: "Can someone walk our team through plan options before we buy?",
      },
      { role: "assistant", content: "sales" },
      {
        role: "user",
        content: "I want to cancel my subscription because uploads keep failing.",
      },
      { role: "assistant", content: "billing" },
      { role: "user", content: message },
      // 最后一条 user 消息才是真正要分类的新输入。
      // 前面的 user/assistant 对话是“示范题”和“标准答案”。
    ],
  });

  return response.choices[0].message.content ?? "";
}

async function main() {
  // 逐条对比 zero-shot 与 few-shot 的输出。
  // 你可以重点观察混合意图的消息：few-shot 往往更容易遵守优先级规则。
  for (const input of inputs) {
    const zeroShot = await classifyZeroShot(input);
    const fewShot = await classifyFewShot(input);

    console.log("Input:");
    console.log(input);
    console.log("\nZero-shot:", zeroShot);
    console.log("Few-shot: ", fewShot);
    console.log("-".repeat(60));
  }
}

main().catch(console.error);
