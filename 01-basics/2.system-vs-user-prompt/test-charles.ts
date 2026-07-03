// ============================================================
//  Charles 代理连通性测试
//
//  这个文件不调用 OpenAI SDK，而是直接用 undici.fetch 测试代理是否可用。
//  如果这里都无法通过代理访问目标地址，SDK 调用也大概率不会成功。
//
//  学习目标：
//  1. 理解代理连通性可以脱离 SDK 单独测试
//  2. 看懂 ProxyAgent 如何把请求转发给 Charles
//  3. 学会先验证网络链路，再排查模型调用代码
// ============================================================

import "dotenv/config";
import { fetch, ProxyAgent } from "undici";

const proxyUrl = process.env.CHARLES_PROXY || "http://10.10.10.103:8888";
// 代理地址可以在 .env 里配置。不同电脑/网络下 IP 可能不同。

console.log("proxy =", proxyUrl);

const dispatcher = new ProxyAgent(proxyUrl);
// dispatcher 告诉 undici：这次请求通过哪个代理发出去。

async function main() {
    const res = await fetch("https://api.deepseek.com", {
        dispatcher,
    } as any);
    // 这里用 as any 是为了简化类型兼容问题。
    // 学习重点是“代理能不能连通”，不是 undici 类型定义。

    console.log("status =", res.status);
    console.log(await res.text());
}

main().catch(console.error);
