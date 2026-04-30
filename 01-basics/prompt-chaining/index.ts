import "dotenv/config";
import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function complete(prompt: string): Promise<string> {
  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    max_tokens: 512,
    messages: [{ role: "user", content: prompt }],
  });
  return response.choices[0].message.content ?? "";
}

async function main() {
  const topic = "building AI agents";

  // Step 1 — generate a compelling blog post title
  console.log("Step 1: Generating title...");
  const title = await complete(
    `Generate one compelling, specific blog post title about: ${topic}. Return only the title, no quotes.`
  );
  console.log("Title:", title);

  // Step 2 — use that title to write an outline (output feeds directly as input)
  console.log("\nStep 2: Writing outline from title...");
  const outline = await complete(
    `Write a 5-point outline for a blog post titled: "${title}". Be specific. Use plain numbered list, no markdown headers.`
  );
  console.log("Outline:\n", outline);

  // Step 3 — expand just the first point into a full paragraph
  console.log("\nStep 3: Expanding first point into a paragraph...");
  const firstPoint = outline.split("\n").find((line) => line.trim()) ?? "";
  const paragraph = await complete(
    `Expand this outline point into one detailed paragraph for a technical audience:\n\n${firstPoint}`
  );
  console.log("Paragraph:\n", paragraph);
}

main().catch(console.error);
