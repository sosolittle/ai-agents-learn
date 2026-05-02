import "dotenv/config";
import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const labels = ["billing", "technical", "sales", "general"] as const;

const rules = `Classify customer support messages as one of: ${labels.join(", ")}.

Rules:
- If a message mentions charge, refund, invoice, payment, or subscription cancellation, classify as billing even if it also mentions API/app issues.
- If it mainly reports a bug, crash, webhook, API failure, or broken upload without money impact, classify as technical.
- If it asks about pricing, onboarding, demos, or plan options before purchase, classify as sales.
- Otherwise classify as general.

Return only the label.`;

const inputs = [
  "I was charged twice after the webhook failed.",
  "The dashboard crashes whenever I upload a CSV.",
  "Do you offer onboarding calls for new teams?",
  "I want to cancel because the API keeps timing out.",
];

async function classifyZeroShot(message: string) {
  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    max_tokens: 20,
    temperature: 0,
    messages: [
      {
        role: "user",
        content: `${rules}\n\nMessage: ${message}`,
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
      { role: "system", content: rules },
      {
        role: "user",
        content: "The API failed and then I got charged for the retry.",
      },
      { role: "assistant", content: "billing" },
      {
        role: "user",
        content: "The webhook returns 500 when I send test events.",
      },
      { role: "assistant", content: "technical" },
      {
        role: "user",
        content: "Can someone walk our team through plan options before we buy?",
      },
      { role: "assistant", content: "sales" },
      {
        role: "user",
        content: "I want to cancel my subscription because uploads keep failing.",
      },
      { role: "assistant", content: "billing" },
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
