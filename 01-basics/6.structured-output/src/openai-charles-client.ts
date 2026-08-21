// ============================================================
//  Charles 调试用 OpenAI 客户端（本模块加强版）
//
//  🏠 生活化比喻：
//  第一课把 SDK 比作「官方电话总机」。这个文件做的事，
//  是给总机换一部「带监听的电话」：
//    - 打给谁（API 端点）一点没变，还是原来那个号码
//    - 变的只是通话路径：让 Charles（抓包工具）能「旁听」每一通电话，
//      把拨出的号码（URL）、说的话（请求体）、对方的回话（响应）都记下来
//  平时（不设 USE_CHARLES）它就是一部普通电话：
//  发请求的行为和直接 new OpenAI(...) 完全一样，
//  唯一的差别是 import 它时会先打几行「体检单」日志（见下）。
//
//  与其他模块同名文件的差别：这一份多了一段「地址改写」逻辑
//  （normalizeChatCompletionsBaseURL，见第一段半）——把讯飞 Coding
//  Plan 配错的 /v1 悄悄改成 /v2，其余服务商原样放行。
//
//  学习目标：
//  1. 看懂 USE_CHARLES / CHARLES_PROXY 两个环境变量如何控制代理
//  2. 理解 ProxyAgent（总机转接）和自定义 fetch（换送信员）的分工
//  3. 看懂「按服务商改写 baseURL」这个兼容性小手法
//
//  核心结论：
//  SDK 看起来是函数调用，本质上仍然是在发 HTTP 请求；请求既然是
//  代码发出去的，就可以在「发出去的路上」动手脚——这是抓包、
//  日志、重试、mock、地址改写等一切中间层的共同原理。
// ============================================================

import OpenAI from "openai";
// OpenAI 官方 SDK（第一课的「官方电话总机」）：帮我们封装 HTTP 请求、
// 鉴权 Header、JSON 序列化和响应解析。

import { fetch, ProxyAgent } from "undici";
// undici 是 Node.js 官方的 HTTP 客户端库（Node 18+ 全局 fetch 的底层）。
//   fetch      → 能发 HTTP 请求的函数，我们自己的「送信员」
//   ProxyAgent → 「总机转接器」：装上它，请求先送到代理再转发真实 API

// ============================================================
//  第一段：读环境变量，决定要不要开「监听」
// ============================================================

const useCharles = process.env.USE_CHARLES === "1";
// USE_CHARLES 就是「监听开关」：只有严格等于字符串 "1" 时才打开。
//
// 📤 输入输出走查（=== "1" 到底有多严格）：
//   .env 写 USE_CHARLES=1    → useCharles === true   （开监听，走代理）
//   .env 写 USE_CHARLES=true → useCharles === false  （不开！"true" 不等于 "1"）
//   .env 不写这个变量        → undefined !== "1"     → false（不开）

const proxyUrl = process.env.CHARLES_PROXY || "http://127.0.0.1:8888";
// USE_CHARLES=1 时才启用代理。CHARLES_PROXY 可覆盖默认代理地址。
// 默认的 127.0.0.1:8888 就是 Charles 在本机的默认监听地址。

const dispatcher = useCharles ? new ProxyAgent(proxyUrl) : undefined;
// undici 的 dispatcher 可以控制请求如何发出。
// 传 ProxyAgent 后，请求会先经过 Charles，再转发到真实 API。
// 开关没开时这里是 undefined：就「发请求」而言等于代理从未存在。

// ============================================================
//  第一段半（本副本特有）：按服务商改写 baseURL
// ============================================================
// 背景：讯飞 Coding Plan 的 .../v1 路径是给 Responses API 用的，
// Chat Completions 接口要走 .../v2。用户如果在 .env 里配了 /v1，
// 这里就把它换成 /v2 并打一行警告提醒「我帮你改了」；
// 其他任何服务商的地址（包括没配置）都原样放行。

export function normalizeChatCompletionsBaseURL(baseURL: string | undefined): string | undefined {
    // 📤 输入输出走查：
    //   ".../v1"    → ".../v2"（改写）
    //   ".../v1/"   → ".../v2"（末尾多个斜杠也算配错，同样改写）
    //   其他任意值  → 原样返回
    //   undefined   → undefined
    const xfyunResponsesBaseURL = "https://maas-coding-api.cn-huabei-1.xf-yun.com/v1";

    if (baseURL === xfyunResponsesBaseURL || baseURL === `${xfyunResponsesBaseURL}/`) {
        return "https://maas-coding-api.cn-huabei-1.xf-yun.com/v2";
    }

    return baseURL;
}

const configuredBaseURL = process.env.OPENAI_BASE_URL;
// .env 里原始配置的地址（改写前的样子）

const baseURL = normalizeChatCompletionsBaseURL(configuredBaseURL);
// 实际使用的地址（改写后的样子）

if (configuredBaseURL && baseURL !== configuredBaseURL) {
    // 只有「确实发生了改写」才警告：拿改写前后一比较就知道动没动手脚。
    console.warn(
        "[Charles Debug] xfyun Coding Plan /v1 is for Responses API; using /v2 for Chat Completions.",
    );
}

console.log("[Charles Debug] USE_CHARLES =", process.env.USE_CHARLES);
console.log("[Charles Debug] CHARLES_PROXY =", proxyUrl);
console.log("[Charles Debug] OPENAI_BASE_URL =", baseURL);
// 体检单第三行打印的是「改写后」的最终地址：启动时看一眼就能确认
// 请求到底会发往哪里（OpenAI 官方 / DeepSeek / 讯飞 /v2 …）。

// ============================================================
//  第二段：造一个「带监听的送信员」（自定义 fetch）
// ============================================================
// SDK 允许在创建客户端时传入自定义 fetch——相当于总机同意你换掉送信员。
// 换上的这个送信员随身带一个打印请求 URL 的探针（默认关着），
// 并知道怎么把信送上代理这条「监听线路」。

const charlesFetch: typeof globalThis.fetch = async (input, init) => {
    // 类型标注 typeof globalThis.fetch：函数必须长得像标准 fetch
    // （同样的参数、返回 Promise<Response>），SDK 才肯用它。

    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    // fetch 第一个参数有三种形态，这里统一转成字符串备用：
    //   字符串 "https://..." → 直接用；URL 对象 → .toString()；Request → .url

    // console.log("[Charles Debug] request url =", url);
    // ↑ 预留的调试开关：想看每个请求的确切 URL 时，把这行放开即可。

    return fetch(input as any, {
        ...(init as any),
        ...(dispatcher ? { dispatcher } : {}),
    }) as any;
    // 真正发请求——用 undici 的 fetch（不是全局 fetch）：
    //   ...init               → SDK 传来的原始参数（Header、Body 等）原样带上
    //   ...(dispatcher ? ...) → 开了监听就附加代理，没开就不加
    //   as any                → undici fetch 与标准 fetch 类型定义略有出入，
    //                           重点在代理机制，不在类型体操
};

// ============================================================
//  第三段：创建客户端并导出
// ============================================================
// 条件展开：只有 useCharles 为 true 时才覆盖 fetch；
// 平时客户端就和普通 OpenAI 客户端一模一样。
//
// 📤 输入输出走查（开关两端各自的链路）：
//   不设 USE_CHARLES：SDK 自带 fetch → 直连 API 服务商，Charles 看不到任何东西
//   USE_CHARLES=1：  每个请求改调 charlesFetch → 经 ProxyAgent 到
//                     Charles（127.0.0.1:8888）→ 转发真实 API → 响应原路返回

const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    // 身份证：API Key 从 .env 读进来（绝不写死在代码里）

    baseURL: baseURL,
    // 目的地：用第一段半改写后的地址——没配走官方；配了讯飞 /v1 已换成 /v2

    ...(useCharles
        ? {
            fetch: charlesFetch,
        }
        : {}),
    // 只有开监听时才把 charlesFetch 交给 SDK（条件展开）
});

export default client;
// 导出客户端：index.ts / index副本.ts 都 import 它，
// 「要不要抓包、走哪个服务商」完全由环境变量决定，业务代码不用改。

// ⚠️ 高危易错点：USE_CHARLES=1 时 Charles 必须真的在跑！
// 开了开关但 Charles 没开，所有请求都发往 127.0.0.1:8888 无人接听，
// 直接连接失败——症状是「程序突然全挂了」。平时不要设 USE_CHARLES。
