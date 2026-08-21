// ============================================================
//  Planner Agent：把模糊目标变成结构化计划（规划师）
//
//  🏠 生活化比喻：
//  规划师的职业纪律：「只出计划，不写答案」。
//  用户说「我想做个习惯打卡 App」——这种模糊愿望到他手里，
//  变成一份工程化的计划书：目标是什么、给谁用、必须有哪些
//  功能、可以有哪些、技术约束、风险、验收标准。
//  计划书必须是 JSON（有合同约束），因为下一道工序
// （工匠）要机器可读地消费它。
//
//  学习目标：
//  1. 让第一个 agent 只负责“理解需求和列计划”
//  2. 用 JSON 输出给后续 Worker 提供稳定输入
//  3. 避免 Planner 直接写最终答案或实现细节
// ============================================================

import "dotenv/config";

// ../config.js：上一级目录的 config（agents/ 是子目录，所以 ../）。
import { MAX_TOKENS, MODEL, TEMPERATURE, getClient } from "../config.js";
import { PlannerOutputSchema, type PlannerOutput } from "../types.js";
import { safeJsonParse } from "../utils.js";

// The Planner Agent has one job: turn a fuzzy user goal into a structured plan.
// It does not write the final answer and it does not implement anything. Its
// only output is the plan contract that the worker will build against.
//
// TS 语法：SYSTEM_PROMPT 用反引号模板字符串书写——内容可以
// 原样跨行（普通引号一换行就报错），很适合放整段提示词。
// 提示词本身也是「纪律清单」：不要写最终答案 / 只输出 JSON /
// 不要 markdown / 不要多余解说——每句都在堵一种跑偏。
const SYSTEM_PROMPT = `You are the Planner Agent.
Your job is to turn the user goal into a clear implementation plan.
Do not write the final answer.
Output only valid JSON.
No markdown.
No extra commentary.

Return a JSON object with exactly these fields:
{
  "objective": string,
  "user_type": string,
  "must_have_features": string[],
  "nice_to_have_features": string[],
  "technical_constraints": string[],
  "risks": string[],
  "acceptance_criteria": string[]
}`;

export async function runPlannerAgent(goal: string): Promise<PlannerOutput> {
  // Planner 的输入只有用户目标，输出必须符合 PlannerOutputSchema。
  // 这一步是把自然语言需求转换成工程化合同。
  //
  // 注意三个生成参数都是 config.ts 的常量：temperature=0（求稳）、
  // max_tokens=1500（计划书要够长）、response_format=json_object
  // （从 API 层面强约束「只许回 JSON」——第一道防线）。
  const response = await getClient().chat.completions.create({
    model: MODEL,
    temperature: TEMPERATURE,
    max_tokens: MAX_TOKENS,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `User goal: ${goal}` },
    ],
  });

  const raw = response.choices[0].message.content ?? "";
  // 第二道防线：验收口。response_format 只是「大概率」守规矩，
  // 真正的保证来自 schema 校验——少一个字段、多一层嵌套、
  // 数组里混进数字，都在这里当场抛错。
  // TS 语法：safeJsonParse<PlannerOutput>(…) 显式写出泛型参数 T——
  // 也可以省略（由 schema 自动推导），写出来是给读代码的人看的。
  return safeJsonParse<PlannerOutput>(raw, "Planner Agent", PlannerOutputSchema);
}
