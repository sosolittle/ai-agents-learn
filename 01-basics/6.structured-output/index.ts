// ============================================================
//  第一课补充：structured-output（结构化输出）
//
//  学习目标：
//  1. 理解为什么业务代码通常需要对象/数组，而不是自由文本
//  2. 学会用 function calling 让模型按 schema 提取字段
//  3. 看懂 JSON Schema 与 TypeScript interface 的对应关系
//
//  这节课的关键点：
//  模型仍然在“生成文本”，但 function calling 会强迫它把结果放进
//  tool call 的 arguments 里，从而更接近程序可消费的数据。
// ============================================================

import "dotenv/config";
import OpenAI from "openai";
import client from "./src/openai-charles-client";

// const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
const isDeepSeekApi = process.env.OPENAI_BASE_URL?.includes("deepseek.com") ?? false;
const toolChoice = isDeepSeekApi
  ? undefined
  : ({ type: "function", function: { name: "extract_job_posting" } } as const);

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
  // 这个函数把“非结构化文本”转换成“结构化对象”。
  // 很多 agent 工作流都会先抽取结构，再做路由、检索、评估或入库。
  const response = await client.chat.completions.create({
    model: model,
    messages: [
      {
        role: "user",
        content: `从下面这段职位描述中提取结构化信息：\n\n${text}。
        要求：
        1. 只返回 JSON，不要输出任何解释。
        2. JSON 必须符合下面格式。
        3. 如果没有薪资，请返回 null。
        4. seniority_level 只能是：junior、mid、senior、lead、unknown
        JSON 格式：
        {
          "job_title": "",
          "company": "",
          "location": "",
          "salary_range": {
            "min": 0,
            "max": 0,
            "currency": ""
          },
          "required_skills": [],
          "seniority_level": ""
        }`,//请调用 extract_job_posting 工具，
      },
    ],
    // tools: [
    //   {
    //     type: "function",
    //     function: {
    //       name: "extract_job_posting",
    //       // 这里的 function 不一定真的要在本地执行。
    //       // 我们把它当作“结构化输出通道”：模型必须填好 arguments。
    //       description: "从职位描述中提取结构化字段",
    //       parameters: {
    //         type: "object",
    //         properties: {
    //           job_title: { type: "string" },
    //           company: { type: "string" },
    //           location: { type: "string" },
    //           salary_range: {
    //             type: ["object", "null"],
    //             // salary_range 可能不存在，所以允许 object 或 null。
    //             // 这比让模型编造薪资更安全。
    //             properties: {
    //               min: { type: "number" },
    //               max: { type: "number" },
    //               currency: { type: "string" },
    //             },
    //             required: ["min", "max", "currency"],
    //           },
    //           required_skills: {
    //             type: "array",
    //             items: { type: "string" },
    //           },
    //           seniority_level: {
    //             type: "string",
    //             enum: ["junior", "mid", "senior", "lead", "unknown"],
    //           },
    //         },
    //         required: [
    //           "job_title",
    //           "company",
    //           "location",
    //           "salary_range",
    //           "required_skills",
    //           "seniority_level",
    //         ],
    //       },
    //     },
    //   },
    // ],
    // ...(toolChoice ? { tool_choice: toolChoice } : {}),
    // OpenAI API 支持用 tool_choice 强制模型调用工具。
    // DeepSeek 的部分思考模型会拒绝这个参数，所以这里改成只传 tools，
    // 并在提示词里明确要求模型调用 extract_job_posting。
  });

  // const toolCall = response.choices[0].message.tool_calls?.[0];
  // if (!toolCall) throw new Error("模型没有返回 tool call");
  // 即使我们强制了 tool_choice，工程代码也仍然要检查异常情况。
  // 网络错误、模型兼容性、供应商差异都可能导致没有 tool_call。

  // return JSON.parse(toolCall.function.arguments) as JobPosting;
  // 这里为了保持示例简洁只做 JSON.parse。
  // 生产代码建议再用 Zod 等工具做一次 schema 校验。

  const message = response.choices[0].message.content??''
  return JSON.parse(message) as JobPosting
}

async function main() {
  for (let i = 0; i < 10; i++) {
    console.log("输入：\n", RAW_JOB_POST.trim());
    console.log("\n正在提取...\n");

    const result = await extractJobPosting(RAW_JOB_POST);

    console.log("提取结果：");
    console.log(JSON.stringify(result, null, 2));
  }
}

main().catch(console.error);
