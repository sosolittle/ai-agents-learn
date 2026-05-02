import "dotenv/config";
import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const userQuestion =
  "Explain what an API rate limit is in one short paragraph.";

const examples = [
  {
    label: "No system prompt",
    systemPrompt: null,
  },
  {
    label: "Backend engineering tutor",
    systemPrompt:
      "You are a concise backend engineering tutor. Explain with practical engineering language.",
  },
  {
    label: "JSON-only API responder",
    systemPrompt:
      "You are a JSON-only API responder. Return an object with keys: concept, explanation, risk, mitigation.",
  },
  {
    label: "Customer support assistant",
    systemPrompt:
      "You are a customer support assistant. Explain this to a non-technical user.",
  },
];

async function main() {
  console.log("User prompt:");
  console.log(userQuestion);
  console.log("-".repeat(60));

  for (const example of examples) {
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      ...(example.systemPrompt
        ? [{ role: "system" as const, content: example.systemPrompt }]
        : []),
      { role: "user", content: userQuestion },
    ];

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 220,
      messages,
    });

    console.log("Case:");
    console.log(example.label);
    console.log("\nSystem prompt:");
    console.log(example.systemPrompt ?? "(none)");
    console.log("\nResponse:");
    console.log(response.choices[0].message.content);
    console.log("-".repeat(60));
  }
}

main().catch(console.error);
