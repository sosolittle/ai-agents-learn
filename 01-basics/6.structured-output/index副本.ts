// ============================================================
//  第一课补充：structured-output（结构化输出）—— function calling 完整版
//
//  🏠 比喻一句话带过（完整展开见 index.ts 文件头）：
//  把模型输出从「手写信」变成「填好的表格」。本文件用的是
//  约束力更强的做法：function calling（tools + tool_choice）。
//
//  与 index.ts 的关系（读代码前先分清两个版本）：
//  - index.ts：现行版。改用「提示词印表头 + JSON.parse」的土办法
//    （因 DeepSeek 思考模型不吃 tool_choice），tools 代码块被注释保留
//  - 本文件（副本）：被注释之前的原版——tools/tool_choice 全部生效，
//    是 OpenAI 系 API 上约束最强的结构化输出写法，保留供对照学习
//
//  学习目标：
//  1. 看懂 tools 里的 JSON Schema 如何规定模型要填的「表格」
//  2. 理解 tool_choice 的强制作用，以及拿到结果后为何仍要防御性检查
//  3. 复习 TS interface ↔ JSON Schema 的对应（展开见 index.ts）
// ============================================================

import "dotenv/config";
import OpenAI from "openai";
import client from "./src/openai-charles-client";

// const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

// 我们希望模型返回的数据形状：定义一次，同时用于工具 schema 和 TS 类型。
interface JobPosting {
  job_title: string;
  company: string;
  location: string;
  salary_range: { min: number; max: number; currency: string } | null;
  required_skills: string[];
  seniority_level: "junior" | "mid" | "senior" | "lead" | "unknown";
}
// JobPosting 是 TypeScript 类型，只在编译期帮助你。
// 下面 tools.parameters 是 JSON Schema，会发给模型，属于运行时约束。
// 两者要保持一致，否则代码以为有字段，模型却可能没返回。

const RAW_JOB_POST = `
  Acme Corp 正在招聘！我们希望找一位高级全栈工程师加入伦敦团队。
  你将和一个小而资深的团队一起开发我们的核心产品。

  我们的要求：5 年以上 React 和 Node.js 经验，有 PostgreSQL 使用经验，
  最好也会一些 TypeScript。加分项：Redis、Docker。

  薪资：根据经验不同，年薪 £85,000 到 £110,000。支持远程办公，
  但我们希望候选人每周能来伦敦办公室 2 天。
`;
// RAW_JOB_POST 模拟一段自然语言职位描述。真实系统里它可能来自网页、
// PDF、用户粘贴内容或数据库字段。

async function extractJobPosting(text: string): Promise<JobPosting> {
  // 这个函数把“非结构化文本”转换成“结构化对象”——把「手写信」
  // 整理成「表格」（比喻的完整展开见 index.ts 文件头）。
  // 很多 agent 工作流都会先抽取结构，再做路由、检索、评估或入库。
  const response = await client.chat.completions.create({
    model: model,
    messages: [
      {
        role: "user",
        content: `请从下面这段职位描述中提取结构化信息：\n\n${text}`,
      },
    ],
    // tools 数组：把「表格的表头规定」用 JSON Schema 写出来发给模型。
    // 注意这个工具并不需要真的执行——我们借它的 arguments
    // 当「结构化输出通道」：模型必须按 schema 把字段填好交上来。
    tools: [
      {
        type: "function",
        function: {
          name: "extract_job_posting",
          // 这里的 function 不一定真的要在本地执行。
          // 我们把它当作“结构化输出通道”：模型必须填好 arguments。
          description: "从职位描述中提取结构化字段",
          parameters: {
            type: "object",
            properties: {
              job_title: { type: "string" },
              company: { type: "string" },
              location: { type: "string" },
              salary_range: {
                type: ["object", "null"],
                // salary_range 可能不存在，所以允许 object 或 null。
                // 这比让模型编造薪资更安全。
                properties: {
                  min: { type: "number" },
                  max: { type: "number" },
                  currency: { type: "string" },
                },
                required: ["min", "max", "currency"],
              },
              required_skills: {
                type: "array",
                items: { type: "string" },
              },
              seniority_level: {
                type: "string",
                // enum = 「只能从这几个里选」，对应 TS 的联合类型
                // "junior" | "mid" | ...（表头里的「勾选项」）
                enum: ["junior", "mid", "senior", "lead", "unknown"],
              },
            },
            required: [
              "job_title",
              "company",
              "location",
              "salary_range",
              "required_skills",
              "seniority_level",
            ],
          },
        },
      },
    ],
    // 强制模型调用我们的工具，而不是返回自由文本：
    // 不强制时模型可能回你一封「手写信」；强制之后它只能去
    // 「填表格」——把每个字段填进 arguments 里交上来。
    tool_choice: { type: "function", function: { name: "extract_job_posting" } },
    // 强制 tool_choice 后，模型不能只写一段说明文字。
    // 它必须调用 extract_job_posting，并把字段放进 arguments。
  });

  const toolCall = response.choices[0].message.tool_calls?.[0];
  if (!toolCall) throw new Error("模型没有返回 tool call");
  // 即使我们强制了 tool_choice，工程代码也仍然要检查异常情况。
  // 网络错误、模型兼容性、供应商差异都可能导致没有 tool_call。

  // ⚠️ 注意：toolCall.function.arguments 是「字符串化的 JSON」而不是
  // 对象——模型填的表格是当成文本传回来的，所以这里还要 parse 一次。
  return JSON.parse(toolCall.function.arguments) as JobPosting;
  // 这里为了保持示例简洁只做 JSON.parse。
  // 生产代码建议再用 Zod 等工具做一次 schema 校验。
}

async function main() {
  console.log("输入：\n", RAW_JOB_POST.trim());
  console.log("\n正在提取...\n");

  const result = await extractJobPosting(RAW_JOB_POST);

  console.log("提取结果：");
  console.log(JSON.stringify(result, null, 2));
}

main().catch(console.error);
