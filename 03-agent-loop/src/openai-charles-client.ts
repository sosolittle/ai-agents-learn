// ============================================================
//  Charles 调试用 OpenAI 客户端
//
//  🏠 生活化比喻：
//  第一课把 SDK 比作「官方电话总机」。这个文件做的事，
//  是给总机换一部「带监听的电话」：
//    - 打给谁（API 端点）一点没变，还是原来那个号码
//    - 变的只是通话路径：让 Charles（抓包工具）能「旁听」每一通电话，
//      把拨出的号码（URL）、说的话（请求体）、对方的回话（响应）都记下来
//  平时（不设 USE_CHARLES）它就是一部普通电话：
//  发请求的行为和直接 new OpenAI(...) 完全一样，
//  唯一的差别是 import 它时会先打三行「体检单」日志（见下）。
//
//  学习目标：
//  1. 看懂 USE_CHARLES / CHARLES_PROXY 两个环境变量如何控制代理
//  2. 理解 ProxyAgent（总机转接）和自定义 fetch（换送信员）的分工
//  3. 学会「用环境变量开关注入调试能力」这个通用手法
//
//  核心结论：
//  SDK 看起来是函数调用，本质上仍然是在发 HTTP 请求；
//  请求既然是代码发出去的，就可以在「发出去的路上」动手脚——
//  这是抓包、日志、重试、mock 等一切中间层的共同原理。
// ============================================================

import OpenAI from "openai";
// OpenAI 官方 SDK（第一课的「官方电话总机」）：
// 帮我们封装 HTTP 请求、鉴权 Header、JSON 序列化和响应解析。

import { fetch, ProxyAgent } from "undici";
// undici 是 Node.js 官方的 HTTP 客户端库（Node 18+ 里全局 fetch 的底层就是它）。
// 这里显式导入两样东西：
//   fetch      → 能发 HTTP 请求的函数，我们自己的「送信员」
//   ProxyAgent → 「总机转接器」：装上它，请求先送到代理，再转发给真实 API

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
// 开关没开时这里是 undefined：undici 按默认方式直连——
// 就「发请求」而言，等于代理这件事完全没发生过
// （只是下面三行体检单日志仍会照打）。

console.log("[Charles 调试] USE_CHARLES =", process.env.USE_CHARLES);
console.log("[Charles 调试] CHARLES_PROXY =", proxyUrl);
console.log("[Charles 调试] OPENAI_BASE_URL =", process.env.OPENAI_BASE_URL);
// 三行「体检单」，不管开不开监听都会打印。启动时先看一眼：
//   USE_CHARLES 到底设没设、代理地址最终用的是哪个、
//   请求要发往哪家服务商（OPENAI_BASE_URL 一眼分辨 OpenAI 官方还是兼容服务）。

// ============================================================
//  第二段：造一个「带监听的送信员」（自定义 fetch）
// ============================================================
// SDK 允许在创建客户端时传入自定义 fetch——相当于总机同意你换掉送信员。
// 换上的这个送信员有两个本领：随身带一个打印请求 URL 的探针（默认关着）、
// 知道怎么把信送上代理这条「监听线路」。

const charlesFetch: typeof globalThis.fetch = async (input, init) => {
    // 类型标注 typeof globalThis.fetch 的意思是：
    // 这个函数必须长得像标准 fetch（同样的参数、返回 Promise<Response>），
    // SDK 才肯用它。真正的「本领」都在函数体里。

    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    // fetch 的第一个参数有三种可能形态，这里统一转成字符串备用：
    //   字符串 "https://..." → 直接用
    //   URL 对象            → .toString() 转成字符串
    //   Request 对象        → 读它的 .url 属性
    // 转出来的 url 目前只服务于下面那行被注释的打印（预留探针）。

    // console.log("[Charles 调试] request url =", url);
    // ↑ 预留的调试开关：想看每个请求的确切 URL 时，把这行放开即可。

    return fetch(input as any, {
        ...(init as any),
        ...(dispatcher ? { dispatcher } : {}),
    }) as any;
    // 真正发请求——用的是 undici 的 fetch（不是全局 fetch）：
    //   ...init               → SDK 传来的原始参数（Header、Body 等）原样带上
    //   ...(dispatcher ? ...) → 开了监听就附加代理，没开就不加这个字段
    //   as any                → undici 的 fetch 与标准 fetch 的类型定义略有出入，
    //                           这里跳过类型纠葛，学习重点在代理机制不在类型体操
};

// ============================================================
//  第三段：创建客户端并导出
// ============================================================
// 条件展开：只有 useCharles 为 true 时才覆盖 fetch。
// 平时运行时，客户端对象本身就和普通 OpenAI 客户端一样
// （三行体检单是加载本模块时打的，不受这个开关控制）。
//
// 📤 输入输出走查（开关两端各自的完整链路）：
//   不设 USE_CHARLES：SDK 用它自带的 fetch → 请求直连 API 服务商，
//                     Charles 里什么都看不到；请求行为与普通客户端
//                     完全一致（仅启动时多打三行体检单，见第一段）
//   USE_CHARLES=1：  SDK 每个请求都改调 charlesFetch → undici fetch
//                     附带 dispatcher → 请求先到 Charles（默认 127.0.0.1:8888）
//                     → Charles 转发给真实 API → 响应原路返回给 SDK
//                     （想看 HTTPS 明文，还需在系统里信任 Charles 的根证书）

const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    // 身份证：API Key 从 .env 读进来（绝不写死在代码里，第一课讲过）

    baseURL: process.env.OPENAI_BASE_URL,
    // 目的地：不设默认走 OpenAI 官方；设了就打兼容服务（如 DeepSeek）

    ...(useCharles
        ? {
            fetch: charlesFetch,
        }
        : {}),
    // 只有开监听时才把 charlesFetch 交给 SDK（条件展开，见本段开头）
});

export default client;
// 导出这个客户端。本模块（以及后续多个模块）的 index.ts 都直接
// import 它——「要不要抓包」完全由环境变量决定，业务代码一行不用改。

// ⚠️ 高危易错点：USE_CHARLES=1 时 Charles 必须真的在跑！
// 开了开关但 Charles 没开（或地址不对），所有请求都会发往 127.0.0.1:8888，
// 本机无人接听，直接连接失败——症状是「程序突然全挂了」。
// 所以平时不要设 USE_CHARLES，需要抓包时再临时打开。
