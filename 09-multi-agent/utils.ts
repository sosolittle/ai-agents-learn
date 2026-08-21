// ============================================================
//  第九章 utils：多 Agent 共用工具（含「验收口」safeJsonParse）
//
//  🏠 生活化比喻：
//  三个岗位之间的传递窗口。最核心的是 safeJsonParse——
//  上一道工序交来的「货」（模型生成的 JSON 文本）必须先过
//  这道质检：先验「是不是合法 JSON」，再验「符不符合合同
//  （Zod schema）」。任何一步不合格，立刻抛出带责任人
//  （agentName）和货物残片（preview）的错误——坏货绝不流入
//  下一道工序，而且一眼能看出是谁的锅。
//
//  学习目标：
//  1. 学会在模型输出边界做 JSON parse + Zod schema 校验
//  2. 用清晰错误信息定位是哪个 agent 的输出坏了
//  3. 把终端打印和文本预览这类小工具集中复用
// ============================================================

// Small helpers shared across the agents.
//
// The JSON parsing here validates each agent's output against a Zod schema so
// that a malformed handoff fails loudly at the boundary. Parse the JSON, then
// confirm its shape matches the contract; otherwise throw a clear error.
// （让坏 handoff 在边界处响亮地失败，而不是悄悄漏进下游。）

import { z } from "zod";

/**
 * Parse a model response that is expected to match a Zod schema.
 * Throws a clear, labelled error if the text is not valid JSON or does not
 * match the schema, so a bad handoff between agents is easy to spot.
 */
// TS 语法：泛型函数（第七章 withTimeout<T> 之后的第二个泛型）。
// <T> 在这里同时出现在两处，像一根线把两端拴在一起：
//   参数 schema: z.ZodType<T>   「能校验出 T 的 schema」
//   返回值     : T              「校验通过后拿到的就是这个类型」
// 于是调用 safeJsonParse(raw, "Planner", PlannerOutputSchema) 时，
// T 被自动推导为 PlannerOutput——传什么合同，就收什么货，
// 不用写任何 as 断言。
export function safeJsonParse<T>(
  raw: string,
  agentName: string,
  schema: z.ZodType<T>
): T {
  // 这个函数是 agent handoff 的“验收口”。
  // 上一个 agent 生成的文本，必须通过这里才能交给下一个 agent。
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 第一关：连 JSON 都不是（截断、markdown 包裹、空串……）。
    // 错误信息带上责任人 + 原文预览，一眼定位。
    throw new Error(
      `${agentName} did not return valid JSON. Got:\n${preview(raw, 200)}`
    );
  }

  // 第二关：是 JSON，但形状不符合同。
  // TS 语法：safeParse vs parse——safeParse 不抛异常，返回
  // { success: true, data } 或 { success: false, error }，
  // 让调用方决定怎么处理；parse 则直接 throw。边界检查用 safe
  // 版，把两种结局都攥在自己手里。
  const result = schema.safeParse(parsed);
  if (!result.success) {
    // result.error.toString() 会列出具体哪个字段、错在哪——
    // 比一句 "invalid" 有用得多。
    throw new Error(
      `${agentName} returned invalid shape.\n${result.error.toString()}\nRaw:\n${preview(raw, 200)}`
    );
  }

  // 类型收窄：success 为 true 时，result.data 的类型就是 T。
  return result.data;
}

/** Print a labelled section header so each stage is easy to read in the console. */
export function printSection(title: string): void {
  // Math.max(标题长度, 12)：短标题也至少有 12 个字符的分隔线，不会太寒酸。
  const line = "─".repeat(Math.max(title.length, 12));
  console.log(`\n${line}\n${title}\n${line}`);
}

/** Pretty-print a value as compact, indented JSON for the console. */
export function prettyJson(value: unknown): string {
  // JSON.stringify 的三参数版：null = 不做替换过滤，2 = 缩进两空格。
  // 输出多行带缩进的可读 JSON，打印结构化产物时最顺手。
  return JSON.stringify(value, null, 2);
}

/** Truncate long text for previews and error messages. */
export function preview(value: unknown, max = 140): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length <= max ? text : `${text.slice(0, max)}...`;
}
