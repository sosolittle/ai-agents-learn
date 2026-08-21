// ============================================================
//  index_original.ts —— prompt-chaining 的「原始参考版」
//
//  与 index.ts 的关系：
//  本文件整体被注释保存，是这套三步链（标题 → 大纲 → 段落）的
//  英文提示词原版；index.ts 是它的中文提示词版，链路逻辑完全相同，
//  只是改为从 .env 读 model、并使用本文件夹共用的 Charles 客户端。
//  两个版本可对照学习中英文提示词的写法差异。
// ============================================================
//
// // ============================================================
// //  第一课补充：prompt-chaining（提示词链）
// //
// //  学习目标：
// //  1. 理解把大任务拆成多个小模型调用的价值
// //  2. 学会把上一步输出作为下一步输入
// //  3. 观察链式调用的风险：前一步出错会影响后一步
// //
// //  Prompt chaining 是很多 agent 工作流的雏形：
// //  title -> outline -> paragraph，就像 plan -> act -> review 的迷你版本。
// // ============================================================
//
// import "dotenv/config";
// import OpenAI from "openai";
//
// const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
//
// async function complete(prompt: string): Promise<string> {
//   // 一个最小的 LLM 调用函数。链式任务里最好把模型调用抽出来，
//   // 这样每一步只需要关心“给什么 prompt、拿什么结果”。
//   const response = await client.chat.completions.create({
//     model: "gpt-4o-mini",
//     max_tokens: 512,
//     messages: [{ role: "user", content: prompt }],
//   });
//   return response.choices[0].message.content ?? "";
// }
//
// async function main() {
//   const topic = "building AI agents";
//   // topic 是整条链的起点。后面每一步都会逐渐把它加工成更具体的内容。
//
//   // Step 1 — generate a compelling blog post title
//   console.log("Step 1: Generating title...");
//   const title = await complete(
//     `Generate one compelling, specific blog post title about: ${topic}. Return only the title, no quotes.`
//   );
//   console.log("Title:", title);
//
//   // Step 2 — use that title to write an outline (output feeds directly as input)
//   console.log("\nStep 2: Writing outline from title...");
//   // 第二步依赖第一步的 title。如果 title 跑偏，outline 也会跟着跑偏。
//   // 这就是链式调用常见的误差传递问题。
//   const outline = await complete(
//     `Write a 5-point outline for a blog post titled: "${title}". Be specific. Use plain numbered list, no markdown headers.`
//   );
//   console.log("Outline:\n", outline);
//
//   // Step 3 — expand just the first point into a full paragraph
//   console.log("\nStep 3: Expanding first point into a paragraph...");
//   const firstPoint = outline.split("\n").find((line) => line.trim()) ?? "";
//   // 这里用非常简单的字符串处理取 outline 第一行。
//   // 生产环境如果需要稳定解析，建议让上一步返回 JSON 数组。
//   const paragraph = await complete(
//     `Expand this outline point into one detailed paragraph for a technical audience:\n\n${firstPoint}`
//   );
//   console.log("Paragraph:\n", paragraph);
// }
//
// main().catch(console.error);
