// ============================================================
//  Charles 调试用 OpenAI 客户端
//
//  这个文件把 OpenAI SDK 的 fetch 替换成一个可选代理版本，
//  方便你用 Charles 之类的抓包工具观察真实 HTTP 请求。
//
//  学习价值：
//  - SDK 看起来是函数调用，本质上仍然是在发 HTTP 请求
//  - 代理可以帮助你看到 URL、请求体、响应状态等底层细节
//  - 调试代理应该由环境变量开关控制，避免平时开发误走代理
// ============================================================

import OpenAI from "openai";
import { fetch, ProxyAgent } from "undici";

const useCharles = process.env.USE_CHARLES === "1";
const proxyUrl = process.env.CHARLES_PROXY || "http://127.0.0.1:8888";
// USE_CHARLES=1 时才启用代理。CHARLES_PROXY 可覆盖默认代理地址。

const dispatcher = useCharles ? new ProxyAgent(proxyUrl) : undefined;
// undici 的 dispatcher 可以控制请求如何发出。
// 传 ProxyAgent 后，请求会先经过 Charles，再转发到真实 API。

console.log("[Charles 调试] USE_CHARLES =", process.env.USE_CHARLES);
console.log("[Charles 调试] CHARLES_PROXY =", proxyUrl);
console.log("[Charles 调试] OPENAI_BASE_URL =", process.env.OPENAI_BASE_URL);

const charlesFetch: typeof globalThis.fetch = async (input, init) => {
    // OpenAI SDK 允许传入自定义 fetch。
    // 这里的函数会打印请求 URL，并在需要时把请求交给代理。

    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    // console.log("[Charles Debug] request url =", url);

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
    // 条件展开：只有 useCharles 为 true 时才覆盖 fetch。
    // 平时运行时，这个客户端就和普通 OpenAI 客户端一样。
});

export default client;
