import "dotenv/config";
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function main() {
  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content:
          "Explain what a large language model is in two sentences, as if talking to a software engineer who has never worked with AI.",
      },
    ],
  });

  const choice = response.choices[0];
  console.log("Response:\n", choice.message.content);
  console.log("\nToken usage:");
  console.log("  Input tokens: ", response.usage?.prompt_tokens);
  console.log("  Output tokens:", response.usage?.completion_tokens);
  console.log("  Stop reason: ", choice.finish_reason);
}

main().catch(console.error);
