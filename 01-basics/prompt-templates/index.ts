import "dotenv/config";
import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

type TemplateVars = {
  language: string;
  format: string;
  focus: string;
  code: string;
};

function reviewPrompt(vars: TemplateVars) {
  return `You are a code reviewer. Review the following ${vars.language} function and respond in ${vars.format}.
Focus on: ${vars.focus}.

\`\`\`${vars.language}
${vars.code}
\`\`\``;
}

const examples: TemplateVars[] = [
  {
    language: "TypeScript",
    format: "bullet points",
    focus: "edge cases",
    code: `function first(items: string[]) {
  return items[0].toUpperCase();
}`,
  },
  {
    language: "Python",
    format: "a numbered list",
    focus: "performance",
    code: `def has_duplicate(items):
    for i in range(len(items)):
        for j in range(len(items)):
            if i != j and items[i] == items[j]:
                return True
    return False`,
  },
  {
    language: "TypeScript",
    format: "one paragraph",
    focus: "naming conventions",
    code: `function calc(x: number, y: number) {
  const z = x * y;
  return z;
}`,
  },
];

async function main() {
  for (const example of examples) {
    const prompt = reviewPrompt(example);

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 300,
      messages: [{ role: "user", content: prompt }],
    });

    console.log("Variables:");
    console.log({
      language: example.language,
      format: example.format,
      focus: example.focus,
    });
    console.log("\nResponse:");
    console.log(response.choices[0].message.content);
    console.log("-".repeat(60));
  }
}

main().catch(console.error);
