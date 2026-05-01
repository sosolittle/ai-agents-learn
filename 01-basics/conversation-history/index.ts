import "dotenv/config";
import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

type Message = OpenAI.ChatCompletionMessageParam;

const messages: Message[] = [
  {
    role: "system",
    content:
      "You are a concise AI engineering tutor. Keep every answer to two sentences.",
  },
];

const userTurns = [
  "What is an AI agent?",
  "How is that different from a normal chatbot?",
  "What should I store if I want the conversation to continue later?",
];

async function main() {
  for (const userTurn of userTurns) {
    messages.push({ role: "user", content: userTurn });

    console.log("\nUser:");
    console.log(userTurn);
    console.log("\nMessages sent to the API:");
    console.log(messages.map((message) => message.role).join(" -> "));

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 250,
      messages,
    });

    const assistantReply = response.choices[0].message.content ?? "";

    messages.push({ role: "assistant", content: assistantReply });

    console.log("\nAssistant:");
    console.log(assistantReply);
    console.log("\nMessages after appending assistant response:");
    console.log(messages.map((message) => message.role).join(" -> "));
    console.log("-".repeat(60));
  }
}

main().catch(console.error);
