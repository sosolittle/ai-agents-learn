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
  if (error.status === 429) return "rate_limit";
  if (error.status !== undefined && error.status >= 500) return "server_error";
  if (error.status === 400) return "bad_request";
  if (error.status === 401) return "auth_error";
  return "unknown_error";
}

function backoffWithJitter(attempt: number) {
  const baseDelayMs = 1000;
  const jitterMs = Math.floor(Math.random() * 250);

  return baseDelayMs * 2 ** (attempt - 1) + jitterMs;
}

async function callWithRetries(prompt: string) {
  const maxAttempts = 4;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // Attempt 1 is intentionally simulated so this example always shows a 429 retry.
      if (attempt === 1) {
        throw { status: 429, message: "Simulated rate limit" };
      }

      // Attempt 2 is intentionally simulated so this example always shows a 500 retry.
      if (attempt === 2) {
        throw { status: 500, message: "Simulated transient server error" };
      }

      console.log(`attempt=${attempt} sending request`);

      const response = await client.chat.completions.create({
        model: "gpt-4o-mini",
        max_tokens: 200,
        messages: [{ role: "user", content: prompt }],
      });

      return response.choices[0].message.content ?? "";
    } catch (error) {
      const apiError = error as ApiLikeError;
      const retryable = isRetryable(apiError);
      const waitMs = backoffWithJitter(attempt);

      console.log(
        `attempt=${attempt} error_type=${errorType(apiError)} status=${apiError.status ?? "none"} retryable=${retryable} wait_ms=${retryable && attempt < maxAttempts ? waitMs : 0}`
      );

      if (!retryable || attempt === maxAttempts) {
        throw error;
      }

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
