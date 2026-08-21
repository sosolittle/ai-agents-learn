// ============================================================
//  第八章 judge：可选的 LLM 裁判（主观题批改老师）
//
//  🏠 生活化比喻：
//  客观题判卷机（evaluator.ts）管不了「这份回答写得好不好」——
//  就像选择题机器批不了作文。于是另请一位老师（还是 gpt-4o-mini），
//  拿着评分细则（rubric）和考生的草稿纸（压缩后的 trace）打分。
//  两条职业守则：
//    ① 老师只批「质量」这种模糊维度，事实题轮不到他；
//    ② 老师自己也会犯错（返回非法 JSON、断网）——
//       所以他的批改失败时记 0 分并写明原因，而不是让整场考试崩掉。
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

// 同文件里既 import 值（preview 函数）又 import 类型（TraceEvent）：
// 前者逗号直接写，后者加 type 关键字，编译后类型部分被擦掉。
import { preview, type TraceEvent } from "./trace.js";

const MODEL = "gpt-4o-mini";
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// TS 语法：参数直接写对象类型（匿名接口）——调用时传
// { input, finalAnswer, trace, rubric } 这样的对象字面量。
// 返回 { passed, score, reasoning }：分数 0~1 + 一句评语。
export async function judgeAnswer(params: {
  input: string;
  finalAnswer: string;
  trace: TraceEvent[];
  rubric: string[];
}): Promise<{ passed: boolean; score: number; reasoning: string }> {
  // The judge is optional and secondary. Use deterministic checks for facts
  // visible in the trace, and the judge only for fuzzy answer-quality checks.
  try {
    // 第一步：把草稿纸「压缩誊抄」。完整 trace 里有 runId、stepNumber、
    // meta 等判卷用不上的字段——只誊抄老师需要的五项，省 token 也降噪。
    // map 把每个事件变成小对象；undefined 的字段序列化时自动省略。
    const compactTrace = params.trace.map((event) => ({
      // 只保留 judge 需要的信息：事件类型、工具名、参数、结果预览和错误。
      // 不把完整 trace 原样塞进去，可以节省 token，也减少噪声。
      type: event.eventType,
      tool: event.toolName,
      args: event.arguments,
      // preview 的第二参数覆盖默认截断长度：结果预览再砍短一点（100）。
      result: event.resultPreview ? preview(event.resultPreview, 100) : undefined,
      error: event.error,
    }));
    // 第二步：请老师批改。response_format 保证输出是 JSON；
    // system 提示词把评分范围（0~1）和「只按 rubric 判」写死，
    // 题面（user 消息）则是整份卷子序列化成 JSON 文本。
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

    // 第三步：验老师的卷。老师被要求返回 JSON，但仍然要 parse +
    // 逐字段检查类型——不能因为他是「裁判模型」，就默认永远守格式。
    // （手法和第七章 parseArgs、tools.ts 的 dispatcher 一脉相承：
    //  外部数据进系统，边界处必须运行时验证。）
    const raw = response.choices[0].message.content ?? "";
    const parsed: unknown = JSON.parse(raw);
    // judge 被要求返回 JSON，但仍然要 parse + 检查字段类型。
    // 不能因为它是“裁判模型”，就默认它永远守格式。
    //
    // TS 语法：parsed as { passed?: unknown } 这样的「断言成宽接口」
    // 只是为了能安全地摸到字段做 typeof 检查——全部通过后才断言成
    // 真正的返回类型。类型层层收紧，最后一步 return 才敢用强类型。
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
    // 裁判的兜底：把「批改失败」本身当成一种批改结果返回，
    // 而不是抛出导致整个评测崩溃——报告里能清楚看到
    // "Judge failed: …"，成绩单不会因此中断。
    const message = error instanceof Error ? error.message : String(error);
    // 裁判失败时返回 failed，而不是抛出导致整个评测崩溃。
    // 这样报告里能清楚看到是 judge 环节出了问题。
    return { passed: false, score: 0, reasoning: `Judge failed: ${message}` };
  }
}
