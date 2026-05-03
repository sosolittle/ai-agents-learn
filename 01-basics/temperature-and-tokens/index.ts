import "dotenv/config";
import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const prompt =
  "Generate 5 product names for a visual AI workflow builder for developers.";

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
    usage: response.usage,
  };
}

async function runCase(label: string, temperature: number, maxTokens: number) {
  const result = await complete(temperature, maxTokens);

  console.log(label);
  console.log(`settings: temperature=${temperature}, max_tokens=${maxTokens}`);
  console.log("\noutput:");
  console.log(result.text);
  console.log("\nfinish_reason:", result.finishReason);

  if (result.usage) {
    console.log(
      `tokens: prompt=${result.usage.prompt_tokens}, completion=${result.usage.completion_tokens}, total=${result.usage.total_tokens}`
    );
  }

  console.log("-".repeat(60));
  return result.text;
}

async function main() {
  console.log("Prompt:");
  console.log(prompt);
  console.log("-".repeat(60));

  const first = await runCase("Call 1", 0, 120);
  const second = await runCase("Call 2", 0, 120);
  console.log("Temperature 0 outputs matched exactly:", first === second);
  console.log("-".repeat(60));

  await runCase("Call 3", 0.7, 120);
  await runCase("Call 4", 1.2, 120);
  await runCase("Call 5", 0.7, 20);
}

main().catch(console.error);
