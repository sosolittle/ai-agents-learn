import "dotenv/config";
import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const messages = [
  {
    role: "user" as const,
    content:
      "Explain streaming responses in two short paragraphs for a Node developer learning AI APIs.",
  },
];

async function main() {
  console.log("Non-streaming call:");
  console.log("Waiting for the whole response...\n");

  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    max_tokens: 300,
    messages,
  });

  console.log(response.choices[0].message.content);

  console.log("\n---\n");
  console.log("Streaming call:");
  console.log("Printing chunks as they arrive...\n");

  const stream = await client.chat.completions.create({
    model: "gpt-4o-mini",
    max_tokens: 300,
    messages,
    stream: true,
  });

  for await (const event of stream) {
    const token = event.choices[0]?.delta?.content;

    if (token) {
      process.stdout.write(token);
    }
  }

  process.stdout.write("\n");
}

main().catch(console.error);
