// ============================================================
//  openai-charles-client 的最小测试（零框架，node:assert 直跑）
//
//  测什么：normalizeChatCompletionsBaseURL 的「地址改写」逻辑——
//    ① 讯飞 /v1       → 应改写成 /v2（Chat Completions 的正确入口）
//    ② OpenAI 官方地址 → 原样返回（不该被误改）
//    ③ undefined      → 原样返回 undefined
//
//  它不联网、不碰模型：加载客户端模块只会构造对象、不发请求，
//  所以先塞一个假 OPENAI_API_KEY 就能安全 import。
// ============================================================

import assert from "node:assert/strict";

process.env.OPENAI_API_KEY = "test-key";
// ↑ 先设假 key 再加载模块——顺序不能反，否则模块加载时读不到。

const { normalizeChatCompletionsBaseURL } = require("./openai-charles-client") as typeof import("./openai-charles-client");

// 用例①：讯飞 /v1 被改写为 /v2
assert.equal(
  normalizeChatCompletionsBaseURL("https://maas-coding-api.cn-huabei-1.xf-yun.com/v1"),
  "https://maas-coding-api.cn-huabei-1.xf-yun.com/v2",
);

// 用例②：其他服务商地址原样放行
assert.equal(
  normalizeChatCompletionsBaseURL("https://api.openai.com/v1"),
  "https://api.openai.com/v1",
);

// 用例③：没配置（undefined）也原样放行
assert.equal(normalizeChatCompletionsBaseURL(undefined), undefined);
