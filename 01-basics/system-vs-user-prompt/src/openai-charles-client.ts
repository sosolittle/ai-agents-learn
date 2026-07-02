import OpenAI from "openai";
import { fetch, ProxyAgent } from "undici";

const useCharles = process.env.USE_CHARLES === "1";
const proxyUrl = process.env.CHARLES_PROXY || "http://127.0.0.1:8888";

const dispatcher = useCharles ? new ProxyAgent(proxyUrl) : undefined;

console.log("[Charles Debug] USE_CHARLES =", process.env.USE_CHARLES);
console.log("[Charles Debug] CHARLES_PROXY =", proxyUrl);
console.log("[Charles Debug] OPENAI_BASE_URL =", process.env.OPENAI_BASE_URL);

const charlesFetch: typeof globalThis.fetch = async (input, init) => {

    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    console.log("[Charles Debug] request url =", url);

    return fetch(input as any, {
        ...(init as any),
        ...(dispatcher ? { dispatcher } : {}),
    }) as any;
};

const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL,

    ...(useCharles
        ? {
            fetch: charlesFetch,
        }
        : {}),
});

export default client;