import "dotenv/config";
import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const inputs = [
  "I was charged twice for my monthly plan.",
  "The dashboard crashes whenever I upload a CSV.",
  "Do you offer onboarding calls for new teams?",
];

async function classifyZeroShot(message: string) {
  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    max_tokens: 20,
    temperature: 0,
    messages: [
      {
        role: "user",
        content: `Classify this customer support message as "billing", "technical", or "general". Return only the label.\n\nMessage: ${message}`,
      },
    ],
  });

  return response.choices[0].message.content ?? "";
}

async function classifyFewShot(message: string) {
  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    max_tokens: 20,
    temperature: 0,
    messages: [
      {
        role: "system",
        content:
          'Classify customer support messages as "billing", "technical", or "general". Return only the label.',
      },
      { role: "user", content: "My invoice amount looks wrong this month." },
      { role: "assistant", content: "billing" },
      { role: "user", content: "The app freezes when I reset my password." },
      { role: "assistant", content: "technical" },
      { role: "user", content: "Can I talk to someone about plan options?" },
      { role: "assistant", content: "general" },
      { role: "user", content: message },
    ],
  });

  return response.choices[0].message.content ?? "";
}

async function main() {
  for (const input of inputs) {
    const zeroShot = await classifyZeroShot(input);
    const fewShot = await classifyFewShot(input);

    console.log("Input:");
    console.log(input);
    console.log("\nZero-shot:", zeroShot);
    console.log("Few-shot: ", fewShot);
    console.log("-".repeat(60));
  }
}

main().catch(console.error);
