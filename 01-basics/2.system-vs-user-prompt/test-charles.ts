// ============================================================
//  Charles 代理连通性测试（test-charles）
//
//  🏠 生活化比喻：
//  正式课程文件（index.ts）打电话要走「电话总机」（SDK）；
//  这个文件跳过总机，拿一根裸电话线直接接到「转接器」（代理）上，
//  先确认线路通不通——线不通，检查电话机（SDK 调用代码）也没用。
//
//  它和 index.ts 的关系（一句话）：
//  index.ts 的模型请求由 src/openai-charles-client.ts 发出（设
//  USE_CHARLES=1 时经代理转发）；本文件不碰 OpenAI SDK，只用 undici
//  的 fetch 直接试一次「能否穿过代理访问外网」，是抓包排障的第一步。
//
//  学习目标：
//  1. 理解代理连通性可以脱离 SDK 单独测试
//  2. 看懂 ProxyAgent 如何把请求转发给 Charles
//  3. 学会先验证网络链路，再排查模型调用代码
//
//  核心结论：
//  网络问题要在网络层验证——能用 10 行裸 fetch 证明的事，
//  不要在 SDK 调用代码里猜。先看到状态码，再回去查模型代码。
// ============================================================

import "dotenv/config";
import { fetch, ProxyAgent } from "undici";
// undici 是 Node.js 官方的 HTTP 客户端库（Node 18+ 全局 fetch 的底层就是它）。
// 这里显式导入两样东西：fetch（发请求的函数）和 ProxyAgent（代理转接器）。

const proxyUrl = process.env.CHARLES_PROXY || "http://10.10.10.103:8888";
// 代理地址可以在 .env 里配置。不同电脑/网络下 IP 可能不同。
//
// 📤 输入输出走查（这行代码的两种取值）：
//   .env 写 CHARLES_PROXY=http://192.168.1.5:8888 → 用这个地址
//   .env 没写这个变量                             → 落到默认 "http://10.10.10.103:8888"
//
// 小心一个坑：这里的默认值和 src/openai-charles-client.ts 的默认值
// （http://127.0.0.1:8888）不一样——好在两个文件读的是同一个
// CHARLES_PROXY 变量，最稳的做法是在 .env 里把它写明白，别依赖各自的默认值。

console.log("proxy =", proxyUrl);
// 先把最终生效的代理地址打出来，避免「以为在测 A、实际连的是 B」。

const dispatcher = new ProxyAgent(proxyUrl);
// dispatcher 告诉 undici：这次请求通过哪个代理发出去。
// 注意和 openai-charles-client.ts 不同：这里无条件创建、不看开关——
// 这个文件本来就是专门用来测代理的。

async function main() {
    const res = await fetch("https://api.deepseek.com", {
        dispatcher,
    } as any);
    // 请求目标是 DeepSeek 的根地址——只为验证「穿过代理能拿到 HTTP 响应」，
    // 和模型调用本身无关；看得到状态码，就说明代理链路是通的。
    // 这里用 as any 是为了简化类型兼容问题。
    // 学习重点是“代理能不能连通”，不是 undici 类型定义。

    console.log("status =", res.status);
    // 预期是 200（或 3xx 重定向）。打印出状态码 = 这条线已经通了。

    console.log(await res.text());
    // 再打印响应正文：能输出内容而不是报错，
    // 说明「请求 → 代理 → 外网 → 响应」整条链路都正常。
}

main().catch(console.error);
// ⚠️ 高危易错点：如果 Charles 没开（或地址写错），这次 fetch 会直接
// 报连接被拒绝/超时（ECONNREFUSED 之类）——这不是「程序写错了」，
// 报错本身就是诊断结论：问题在代理链路，先把 Charles 打开再重跑。
