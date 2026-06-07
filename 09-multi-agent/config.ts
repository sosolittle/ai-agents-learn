import OpenAI from "openai";

export const MODEL = "gpt-4o-mini";
export const MAX_TOKENS = 1500;
export const TEMPERATURE = 0;

let _client: OpenAI | null = null;

export function getClient(): OpenAI {
  if (!_client) {
    _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _client;
}
