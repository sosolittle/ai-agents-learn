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

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// The shape we want back — defined once, used for both the tool schema and TS types
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
  We're hiring at Acme Corp! Looking for a Senior Full-Stack Engineer to join our
  London team. You'll work on our core product alongside a small, senior team.

  What we need: 5+ years with React and Node.js, experience with PostgreSQL,
  and ideally some TypeScript. Nice to have: Redis, Docker.

  Salary: £85,000 – £110,000 depending on experience. Remote-friendly but
  we'd love someone who can come into London 2 days a week.
`;
// RAW_JOB_POST 模拟一段自然语言职位描述。真实系统里它可能来自网页、
// PDF、用户粘贴内容或数据库字段。

async function extractJobPosting(text: string): Promise<JobPosting> {
  // 这个函数把“非结构化文本”转换成“结构化对象”。
  // 很多 agent 工作流都会先抽取结构，再做路由、检索、评估或入库。
  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "user",
        content: `Extract structured information from this job posting:\n\n${text}`,
      },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "extract_job_posting",
          // 这里的 function 不一定真的要在本地执行。
          // 我们把它当作“结构化输出通道”：模型必须填好 arguments。
          description: "Extract structured fields from a job posting",
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
    // Force the model to call our tool rather than responding in free text
    tool_choice: { type: "function", function: { name: "extract_job_posting" } },
    // 强制 tool_choice 后，模型不能只写一段说明文字。
    // 它必须调用 extract_job_posting，并把字段放进 arguments。
  });

  const toolCall = response.choices[0].message.tool_calls?.[0];
  if (!toolCall) throw new Error("Model did not return a tool call");
  // 即使我们强制了 tool_choice，工程代码也仍然要检查异常情况。
  // 网络错误、模型兼容性、供应商差异都可能导致没有 tool_call。

  return JSON.parse(toolCall.function.arguments) as JobPosting;
  // 这里为了保持示例简洁只做 JSON.parse。
  // 生产代码建议再用 Zod 等工具做一次 schema 校验。
}

async function main() {
  console.log("Input:\n", RAW_JOB_POST.trim());
  console.log("\nExtracting...\n");

  const result = await extractJobPosting(RAW_JOB_POST);

  console.log("Extracted:");
  console.log(JSON.stringify(result, null, 2));
}

main().catch(console.error);
