import OpenAI from "openai";
import { fetch, ProxyAgent } from "undici";

const useCharles = process.env.USE_CHARLES === "1";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL,

  ...(useCharles
    ? {
        fetch: fetch as unknown as typeof globalThis.fetch,
        fetchOptions: {
          dispatcher: new ProxyAgent(
            process.env.CHARLES_PROXY || "http://127.0.0.1:8888"
          ),
        } as any,
      }
    : {}),
});

export default client;
