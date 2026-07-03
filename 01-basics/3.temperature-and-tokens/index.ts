// ============================================================
//  第一课补充：温度参数与 token 限制（随机性与 token 限制）
//
//  学习目标：
//  1. 理解温度参数如何影响模型输出的稳定性和创造性
//  2. 理解最大 token 数如何限制模型最多能生成多少内容
//  3. 学会查看用量统计，估算一次调用的 token 成本
//
//  核心结论：
//  - 温度参数越低，输出越稳定，适合分类、抽取、评测。
//  - 温度参数越高，输出越发散，适合头脑风暴、命名、创意写作。
//  - 最大 token 数不是“期望长度”，而是“输出上限”。
// ============================================================

import "dotenv/config";
import client from "./src/openai-charles-client";

// const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

const prompt =
  "为面向开发者的可视化 AI 工作流构建器生成 5 个产品名称。";
// 所有实验都使用同一个提示词。这样我们能把变量控制住，
// 更清楚地看到温度参数和最大 token 数对输出的影响。

async function complete(temperature: number, maxTokens: number) {
  // complete 是一个小包装函数：输入模型参数，返回输出文本和统计信息。
  // 真实项目里经常会把模型调用包成这种函数，方便复用和统一记录日志。
  const response = await client.chat.completions.create({
    model: model,
    temperature,
    max_tokens: maxTokens,
    // max_tokens 限制“最多生成多少 token”。
    // 如果上限太小，模型可能来不及完整回答，结束原因会提示被截断。
    messages: [{ role: "user", content: prompt }],
  });

  const choice = response.choices[0];
  // choices 是候选回复数组。多数普通调用只要第一个候选回复。

  return {
    text: choice.message.content ?? "",
    finishReason: choice.finish_reason,
    usage: response.usage,
    // 用量统计里包含提示词 token 数、补全 token 数、总 token 数。
    // 学习智能体时一定要关心它，因为“上下文越长、工具结果越多”，成本越高。
  };
}

async function runCase(label: string, temperature: number, maxTokens: number) {
  // runCase 负责跑一组参数并打印结果。
  // 把实验步骤封装起来，可以让 main() 更像一张实验表。
  const result = await complete(temperature, maxTokens);

  console.log(label);
  console.log(`设置：温度参数=${temperature}，最大 token 数=${maxTokens}`);
  console.log("\n输出：");
  console.log(result.text);
  console.log("\n结束原因：", result.finishReason);

  if (result.usage) {
    console.log(
      `token 用量：提示词=${result.usage.prompt_tokens}，补全=${result.usage.completion_tokens}，总计=${result.usage.total_tokens}`
    );
  }

  console.log("-".repeat(60));
  return result.text;
}

async function main() {
  console.log("提示词：");
  console.log(prompt);
  console.log("-".repeat(60));

  const first = await runCase("调用 1", 0, 120);
  const second = await runCase("调用 2", 0, 120);
  // 温度参数为 0 并不代表数学意义上的“永远完全相同”，
  // 但它通常会显著降低随机性，适合观察稳定输出。
  console.log("温度参数为 0 的两次输出是否完全一致：", first === second);
  console.log("-".repeat(60));

  await runCase("调用 3", 0.7, 120);
  await runCase("调用 4", 1.2, 120);
  await runCase("调用 5", 0.7, 20);
  // 最后一组故意把最大 token 数设小，方便观察输出被限制时的效果。
}

main().catch(console.error);
