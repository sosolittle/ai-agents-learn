import "dotenv/config";
import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const userQuestion =
  "Explain what an API rate limit is in one short paragraph.";

const systemPrompts = [
  null,
  "You are a pirate. Respond only in pirate speak.",
  "You are a senior backend engineer. Be terse and precise.",
];

async function main() {
  for (const systemPrompt of systemPrompts) {
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      ...(systemPrompt
        ? [{ role: "system" as const, content: systemPrompt }]
        : []),
      { role: "user", content: userQuestion },
    ];

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 200,
      messages,
    });

    console.log("System prompt:");
    console.log(systemPrompt ?? "(none)");
    console.log("\nResponse:");
    console.log(response.choices[0].message.content);
    console.log("-".repeat(60));
  }
}

main().catch(console.error);
