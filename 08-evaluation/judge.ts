// ============================================================
//  第八章 judge：可选的 LLM 裁判
//
//  学习目标：
//  1. 理解 LLM judge 适合评估“回答质量”这类模糊标准
//  2. 明白 judge 也会失败，所以必须捕获错误并返回结构化结果
//  3. 学会把 trace 压缩后交给 judge，避免上下文过长
//
//  注意：
//  LLM judge 是辅助，不是绝对真理。能用代码判断的条件，仍然放在 evaluator.ts。
// ============================================================

import "dotenv/config";
import OpenAI from "openai";

import { preview, type TraceEvent } from "./trace.js";

const MODEL = "gpt-4o-mini";
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function judgeAnswer(params: {
  input: string;
  finalAnswer: string;
  trace: TraceEvent[];
  rubric: string[];
}): Promise<{ passed: boolean; score: number; reasoning: string }> {
  // The judge is optional and secondary. Use deterministic checks for facts
  // visible in the trace, and the judge only for fuzzy answer-quality checks.
  try {
    const compactTrace = params.trace.map((event) => ({
      // 只保留 judge 需要的信息：事件类型、工具名、参数、结果预览和错误。
      // 不把完整 trace 原样塞进去，可以节省 token，也减少噪声。
      type: event.eventType,
      tool: event.toolName,
      args: event.arguments,
      result: event.resultPreview ? preview(event.resultPreview, 100) : undefined,
      error: event.error,
    }));
    const response = await client.chat.completions.create({
      model: MODEL,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You evaluate customer-support agent answers. Return strict JSON only with " +
            'this shape: {"passed":true,"score":0.9,"reasoning":"brief explanation"}. ' +
            "Score from 0 to 1. Judge only the supplied rubric and trace.",
        },
        {
          role: "user",
          content: JSON.stringify({
            userInput: params.input,
            finalAnswer: params.finalAnswer,
            trace: compactTrace,
            rubric: params.rubric,
          }),
        },
      ],
    });

    const raw = response.choices[0].message.content ?? "";
    const parsed: unknown = JSON.parse(raw);
    // judge 被要求返回 JSON，但仍然要 parse + 检查字段类型。
    // 不能因为它是“裁判模型”，就默认它永远守格式。
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      typeof (parsed as { passed?: unknown }).passed !== "boolean" ||
      typeof (parsed as { score?: unknown }).score !== "number" ||
      typeof (parsed as { reasoning?: unknown }).reasoning !== "string"
    ) {
      throw new Error("response did not match the expected JSON shape");
    }
    return parsed as { passed: boolean; score: number; reasoning: string };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // 裁判失败时返回 failed，而不是抛出导致整个评测崩溃。
    // 这样报告里能清楚看到是 judge 环节出了问题。
    return { passed: false, score: 0, reasoning: `Judge failed: ${message}` };
  }
}
