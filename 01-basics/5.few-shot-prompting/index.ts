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
import client from "./src/openai-charles-client";

// const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
// client 是和 OpenAI API 通信的客户端。这里使用 dotenv/config，
// Node 启动时会自动读取 .env，把 OPENAI_API_KEY 放进 process.env。

const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

const labels = ["billing", "technical", "sales", "general"] as const;
// as const 会把数组元素固定为字面量类型，而不是普通 string。
// 这样 TypeScript 知道 labels 只能是这四个具体分类。

const rules = `请将客户支持消息分类为以下标签之一：${labels.join(", ")}。

分类规则：
- 如果消息提到扣费、退款、发票、付款或取消订阅，请分类为 billing，即使它同时提到 API 或应用问题。
- 如果消息主要是在反馈 bug、崩溃、webhook、API 调用失败，或上传功能损坏，并且没有造成金钱影响，请分类为 technical。
- 如果消息是在购买前询问价格、上手指导、产品演示或套餐选项，请分类为 sales。
- 其他情况请分类为 general。

请只返回标签本身。`;
// rules 是分类任务的“评分标准”。真实客服场景里，规则越清楚，
// 模型越不容易把“退款 + 技术故障”这种混合问题分错类。

const inputs = [
  "webhook 失败后，我被重复扣费了两次。",
  "每次上传 CSV 文件时，控制台都会崩溃。",
  "你们会为新团队提供上手指导电话吗？",
  "我想取消订阅，因为 API 一直超时。",
];
// inputs 是要测试的客户消息。它们故意包含一些容易混淆的情况，
// 比如既提到 webhook/API，又提到 charged/cancel。

async function classifyZeroShot(message: string) {
  // Zero-shot 版本：只把规则和当前消息发给模型，不提供任何示例。
  // 这能测试“规则本身”是否足够清晰。
  const response = await client.chat.completions.create({
    model: model,
    max_tokens: 2000,
    temperature: 0,
    // temperature: 0 让输出尽量稳定。分类任务通常希望可重复，
    // 不希望同一条工单这次是 billing、下次变成 technical。
    messages: [
      {
        role: "user",
        content: `${rules}\n\n客户消息：${message}`,
      },
    ],
    // messages: [
    //   { role: "system", content: rules },
    //   { role: "user", content: `客户消息：${message}` },
    // ]
  });

  return response.choices[0].message.content ?? "";
}

async function classifyFewShot(message: string) {
  // Few-shot 版本：先提供几组完整示例，再让模型分类新的 message。
  // 示例的作用不是“存数据库”，而是临时放进上下文里给模型模仿。
  const response = await client.chat.completions.create({
    model: model,
    max_tokens: 2000,
    temperature: 0,
    messages: [
      { role: "system", content: rules },
      {
        role: "user",
        content: "API 调用失败后，我又因为重试被扣费了。",
      },
      { role: "assistant", content: "billing" },
      {
        role: "user",
        content: "我发送测试事件时，webhook 返回 500。",
      },
      { role: "assistant", content: "technical" },
      {
        role: "user",
        content: "购买前可以有人带我们团队了解一下套餐选项吗？",
      },
      { role: "assistant", content: "sales" },
      {
        role: "user",
        content: "我想取消订阅，因为上传一直失败。",
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

    console.log("输入：");
    console.log(input);
    console.log("\nZero-shot:", zeroShot);
    console.log("Few-shot: ", fewShot);
    console.log("-".repeat(60));
  }
}

main().catch(console.error);
