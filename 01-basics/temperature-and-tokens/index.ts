// ============================================================
//  第一课补充：temperature-and-tokens（随机性与 token 限制）
//
//  学习目标：
//  1. 理解 temperature 如何影响模型输出的稳定性和创造性
//  2. 理解 max_tokens 如何限制模型最多能生成多少内容
//  3. 学会查看 usage，估算一次调用的 token 成本
//
//  核心结论：
//  - temperature 越低，输出越稳定，适合分类、抽取、评测。
//  - temperature 越高，输出越发散，适合头脑风暴、命名、创意写作。
//  - max_tokens 不是“期望长度”，而是“输出上限”。
// ============================================================

import "dotenv/config";
import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const prompt =
  "Generate 5 product names for a visual AI workflow builder for developers.";
// 所有实验都使用同一个 prompt。这样我们能把变量控制住，
// 更清楚地看到 temperature 和 max_tokens 对输出的影响。

async function complete(temperature: number, maxTokens: number) {
  // complete 是一个小包装函数：输入模型参数，返回输出文本和统计信息。
  // 真实项目里经常会把模型调用包成这种函数，方便复用和统一记录日志。
  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    temperature,
    max_tokens: maxTokens,
    // max_tokens 限制“最多生成多少 token”。
    // 如果上限太小，模型可能来不及完整回答，finish_reason 会提示被截断。
    messages: [{ role: "user", content: prompt }],
  });

  const choice = response.choices[0];
  // choices 是候选回复数组。多数普通调用只要第一个 choice。

  return {
    text: choice.message.content ?? "",
    finishReason: choice.finish_reason,
    usage: response.usage,
    // usage 里包含 prompt_tokens、completion_tokens、total_tokens。
    // 学 agent 时一定要关心它，因为“上下文越长、工具结果越多”，成本越高。
  };
}

async function runCase(label: string, temperature: number, maxTokens: number) {
  // runCase 负责跑一组参数并打印结果。
  // 把实验步骤封装起来，可以让 main() 更像一张实验表。
  const result = await complete(temperature, maxTokens);

  console.log(label);
  console.log(`settings: temperature=${temperature}, max_tokens=${maxTokens}`);
  console.log("\noutput:");
  console.log(result.text);
  console.log("\nfinish_reason:", result.finishReason);

  if (result.usage) {
    console.log(
      `tokens: prompt=${result.usage.prompt_tokens}, completion=${result.usage.completion_tokens}, total=${result.usage.total_tokens}`
    );
  }

  console.log("-".repeat(60));
  return result.text;
}

async function main() {
  console.log("Prompt:");
  console.log(prompt);
  console.log("-".repeat(60));

  const first = await runCase("Call 1", 0, 120);
  const second = await runCase("Call 2", 0, 120);
  // temperature=0 并不代表数学意义上的“永远完全相同”，
  // 但它通常会显著降低随机性，适合观察稳定输出。
  console.log("Temperature 0 outputs matched exactly:", first === second);
  console.log("-".repeat(60));

  await runCase("Call 3", 0.7, 120);
  await runCase("Call 4", 1.2, 120);
  await runCase("Call 5", 0.7, 20);
  // 最后一组故意把 max_tokens 设小，方便观察输出被限制时的效果。
}

main().catch(console.error);
