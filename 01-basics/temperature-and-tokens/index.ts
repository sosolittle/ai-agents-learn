import "dotenv/config";
import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const prompt = "Name three great programming languages and briefly say why.";

async function complete(temperature: number, maxTokens: number) {
  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    temperature,
    max_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }],
  });

  const choice = response.choices[0];

  return {
    text: choice.message.content ?? "",
    finishReason: choice.finish_reason,
  };
}

async function main() {
  console.log("Prompt:");
  console.log(prompt);
  console.log("-".repeat(60));

  const first = await complete(0, 50);
  console.log("Call 1: temperature=0, max_tokens=50");
  console.log(first.text);
  console.log("finish_reason:", first.finishReason);
  console.log("-".repeat(60));

  const second = await complete(0, 50);
  console.log("Call 2: temperature=0, max_tokens=50");
  console.log(second.text);
  console.log("finish_reason:", second.finishReason);
  console.log("Matched call 1:", second.text === first.text);
  console.log("-".repeat(60));

  const third = await complete(1.2, 50);
  console.log("Call 3: temperature=1.2, max_tokens=50");
  console.log(third.text);
  console.log("finish_reason:", third.finishReason);
  console.log("-".repeat(60));

  const fourth = await complete(0, 10);
  console.log("Call 4: temperature=0, max_tokens=10");
  console.log(fourth.text);
  console.log("finish_reason:", fourth.finishReason);
}

main().catch(console.error);
