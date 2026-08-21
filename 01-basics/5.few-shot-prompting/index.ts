// ============================================================
//  第一课补充：few-shot-prompting（少样本提示）
//
//  🏠 生活化比喻：
//  把模型当成一位「刚入职的客服新员工」：
//    - zero-shot（零样本）= 只递给他一页《分类规章制度》，
//      让他照着条文自己判断每张工单该归哪个组
//    - few-shot（少样本）= 规章制度之外，再给他看几份
//      「老员工处理过的真实工单 + 老员工写下的标准答案」
//  条文写得再细，也不如几份真实案例直观——人类是这样学会
//  「照着做」的，模型也是：它在上下文里看到的每组
//  「输入 → 正确输出」的示范，都会被它当作模仿的样板。
//
//  学习目标：
//  1. 理解 zero-shot 和 few-shot 的区别
//  2. 观察“规则 + 示例”如何影响模型分类结果
//  3. 学会用低 temperature 做稳定分类任务
//
//  核心结论：
//  - Zero-shot：只给规则，不给示例，让模型直接完成任务。
//  - Few-shot：除了规则，还给几组“输入 -> 正确输出”的示范。
//  - 当分类边界容易混淆（一条消息既有技术故障又涉及扣费）时，
//    示例比单纯的规则条文更能「演示」出正确的判断方式
//  - ⚠️ 示例不等于模型「学会了」：它只是临时放在上下文里的参考答案，
//    每次请求都要整份重发一遍模型才「记得」，token 费用也随之重复产生
// ============================================================

import "dotenv/config";
import OpenAI from "openai";
import client from "./src/openai-charles-client";

// const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
// client 是和 OpenAI API 通信的客户端（第一课的比喻：「官方电话总机」；
// 本文件夹把它换成了可挂 Charles 监听的版本，见 src/openai-charles-client.ts）。
// 这里使用 dotenv/config，Node 启动时会自动读取 .env，
// 把 OPENAI_API_KEY 放进 process.env。

const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

const labels = ["billing", "technical", "sales", "general"] as const;
// as const 会把数组元素固定为字面量类型，而不是普通 string。
// 这样 TypeScript 知道 labels 只能是这四个具体分类。
//
// 📤 输入输出走查（as const 前后的类型变化）：
//   不加 as const → string[]（任意字符串都合法，拼错 "billng" 编译器也不管）
//   加上 as const → readonly ["billing", "technical", "sales", "general"]
//   （元素被锁定为这四个字面量，别处想引用「标签类型」时有了精确依据）

const rules = `请将客户支持消息分类为以下标签之一：${labels.join(", ")}。

分类规则：
- 如果消息提到扣费、退款、发票、付款或取消订阅，请分类为 billing，即使它同时提到 API 或应用问题。
- 如果消息主要是在反馈 bug、崩溃、webhook、API 调用失败，或上传功能损坏，并且没有造成金钱影响，请分类为 technical。
- 如果消息是在购买前询问价格、上手指导、产品演示或套餐选项，请分类为 sales。
- 其他情况请分类为 general。

请只返回标签本身。`;
// rules 是分类任务的“评分标准”，也就是比喻里那页《规章制度》。
// 真实客服场景里，规则越清楚，模型越不容易把“退款 + 技术故障”
// 这种混合问题分错类。
// 注意第一条规则特意写了「即使它同时提到 API 或应用问题」——
// 这是在给「钱 > 技术」的优先级立规矩。下面的 few-shot 示例
// 也遵守了同一条优先级（技术故障 + 扣费 → billing）：
// 规则和示例的说法必须一致，否则模型会无所适从。

const inputs = [
  "webhook 失败后，我被重复扣费了两次。",
  "每次上传 CSV 文件时，控制台都会崩溃。",
  "你们会为新团队提供上手指导电话吗？",
  "我想取消订阅，因为 API 一直超时。",
];
// inputs 是要测试的客户消息。它们故意包含一些容易混淆的情况，
// 比如既提到 webhook/API，又提到 charged/cancel。

async function classifyZeroShot(message: string) {
  // Zero-shot 版本：把规则和当前消息拼在一条 user 消息里发给模型，
  // 不提供任何示例——相当于只给新员工一页规章制度，就直接让他
  // 上手处理第一张工单。这能测试“规则本身”是否足够清晰。
  const response = await client.chat.completions.create({
    model: model,
    max_tokens: 2000,
    temperature: 0,
    // temperature: 0 让输出尽量稳定。分类任务要的是「法官」不是「诗人」：
    // 判决必须可重复——同一张工单这次判 billing、下次判 technical 是事故，
    // 所以把选词随机性压到最低（temperature 的「骰子面数」比喻见第 3 课）。
    messages: [
      {
        role: "user",
        content: `${rules}\n\n客户消息：${message}`,
      },
    ],
    // 下面这段被注释的写法是等价替代：规则放 system、消息放 user。
    // 两种写法喂给模型的文本几乎相同，但语义上 system/user 的分工
    // 更清晰（第 2 课的比喻：system = 岗位说明书，user = 客户当场的问题）。
    // messages: [
    //   { role: "system", content: rules },
    //   { role: "user", content: `客户消息：${message}` },
    // ]
  });

  return response.choices[0].message.content ?? "";
}

async function classifyFewShot(message: string) {
  // Few-shot 版本：先提供几组完整示例，再让模型分类新的 message。
  // 示例的作用不是“存数据库”，而是临时放进上下文里给模型模仿——
  // 在模型眼里，这是一场「已经进行到一半的对话」：前几轮问答
  // 是老员工做过的示范，最后一轮才是留给它答的新题。
  //
  // 📤 输入输出走查（以 inputs 里的混合消息为例）：
  //   待分类：'我想取消订阅，因为 API 一直超时。'
  //   ① 模型先读到 system 里的规则：提到取消订阅 → billing，
  //      且「即使它同时提到 API 问题」也优先算 billing
  //   ② 再看到上下文里的示范题（节选）：
  //      'API 调用失败后，我又因为重试被扣费了。'  → "billing"
  //      '我想取消订阅，因为上传一直失败。'        → "billing"
  //      '我发送测试事件时，webhook 返回 500。'     → "technical"
  //   ③ 新消息同时踩中「取消订阅」和「API 超时」，结构上几乎复刻了
  //      第 ② 组示范（取消订阅 + 技术故障 → billing），模型照样板模仿
  //   ④ 输出："billing"——这正是本演示要观察的重点：混合意图下
  //      few-shot 往往比 zero-shot 更稳，「看案例」比「读条文」
  //      更接近模型实际的推理方式
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
  // 逐条对比 zero-shot 与 few-shot 的输出（同一批 inputs 跑两种版本，
  // 对照实验思路：固定输入和规则，只变「有没有示例」这一个变量）。
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
