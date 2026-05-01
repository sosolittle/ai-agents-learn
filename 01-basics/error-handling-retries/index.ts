import "dotenv/config";
import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

type ApiLikeError = {
  status?: number;
  message?: string;
};

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(error: ApiLikeError) {
  return error.status === 429 || (error.status !== undefined && error.status >= 500);
}

function errorType(error: ApiLikeError) {
  if (error.status === 429) return "rate limit";
  if (error.status !== undefined && error.status >= 500) return "server error";
  if (error.status === 400) return "bad request";
  if (error.status === 401) return "auth error";
  return "unknown error";
}

async function callWithRetries(prompt: string) {
  const maxRetries = 3;
  const maxAttempts = maxRetries + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (attempt === 1) {
        throw { status: 429, message: "Simulated rate limit" };
      }

      if (attempt === 2) {
        throw { status: 500, message: "Simulated transient server error" };
      }

      console.log(`Attempt ${attempt}: sending request`);

      const response = await client.chat.completions.create({
        model: "gpt-4o-mini",
        max_tokens: 200,
        messages: [{ role: "user", content: prompt }],
      });

      return response.choices[0].message.content ?? "";
    } catch (error) {
      const apiError = error as ApiLikeError;
      const waitMs = 1000 * 2 ** (attempt - 1);

      console.log(
        `Attempt ${attempt}: ${errorType(apiError)} (${apiError.status ?? "no status"})`
      );

      if (!isRetryable(apiError) || attempt === maxAttempts) {
        throw error;
      }

      console.log(`Waiting ${waitMs / 1000}s before retry...`);
      await wait(waitMs);
    }
  }

  throw new Error("Retry loop ended without a response.");
}

async function main() {
  const result = await callWithRetries(
    "Explain exponential backoff in two sentences for a backend engineer."
  );

  console.log("\nFinal result:");
  console.log(result);
}

main().catch(console.error);
