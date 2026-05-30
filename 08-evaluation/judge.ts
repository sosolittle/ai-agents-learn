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
    return { passed: false, score: 0, reasoning: `Judge failed: ${message}` };
  }
}
