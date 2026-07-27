// ============================================================
//  第一课补充：prompt-chaining（提示词链）
//
//  学习目标：
//  1. 理解把大任务拆成多个小模型调用的价值
//  2. 学会把上一步输出作为下一步输入
//  3. 观察链式调用的风险：前一步出错会影响后一步
//
//  Prompt chaining 是很多 agent 工作流的雏形：
//  title -> outline -> paragraph，就像 plan -> act -> review 的迷你版本。
// ============================================================

import "dotenv/config";
import OpenAI from "openai";
import client from "./src/openai-charles-client";

// const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

async function complete(prompt: string): Promise<string> {
  // 一个最小的 LLM 调用函数。链式任务里最好把模型调用抽出来，
  // 这样每一步只需要关心“给什么 prompt、拿什么结果”。
  const response = await client.chat.completions.create({
    model: model,
    max_tokens: 512,
    messages: [{ role: "user", content: prompt }],
  });
  return response.choices[0].message.content ?? "";
}

async function main() {
  const topic = "构建 AI 智能体";
  // topic 是整条链的起点。后面每一步都会逐渐把它加工成更具体的内容。

  // Step 1 — generate a compelling blog post title
  console.log("步骤 1：正在生成标题...");
  const title = await complete(
    `请围绕“${topic}”生成一个有吸引力且主题明确的博客文章标题。只返回标题，不要添加引号或其他说明。`
  );
  console.log("标题：", title);

  // Step 2 — use that title to write an outline (output feeds directly as input)
  console.log("\n步骤 2：正在根据标题编写大纲...");
  // 第二步依赖第一步的 title。如果 title 跑偏，outline 也会跟着跑偏。
  // 这就是链式调用常见的误差传递问题。
  const outline = await complete(
    `请为标题为“${title}”的博客文章编写一份包含 5 个要点的具体大纲。使用普通的数字编号列表，不要使用 Markdown 标题。`
  );
  console.log("大纲：\n", outline);

  // Step 3 — expand just the first point into a full paragraph
  console.log("\n步骤 3：正在将第一条大纲扩写成段落...");
  const firstPoint = outline.split("\n").find((line) => line.trim()) ?? "";
  // 这里用非常简单的字符串处理取 outline 第一行。
  // 生产环境如果需要稳定解析，建议让上一步返回 JSON 数组。
  const paragraph = await complete(
    `请面向技术读者，将下面这条大纲扩写成一个内容详实的段落：\n\n${firstPoint}`
  );
  console.log("段落：\n", paragraph);
}

main().catch(console.error);
