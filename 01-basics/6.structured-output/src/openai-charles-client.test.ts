import assert from "node:assert/strict";

process.env.OPENAI_API_KEY = "test-key";

const { normalizeChatCompletionsBaseURL } = require("./openai-charles-client") as typeof import("./openai-charles-client");

assert.equal(
  normalizeChatCompletionsBaseURL("https://maas-coding-api.cn-huabei-1.xf-yun.com/v1"),
  "https://maas-coding-api.cn-huabei-1.xf-yun.com/v2",
);

assert.equal(
  normalizeChatCompletionsBaseURL("https://api.openai.com/v1"),
  "https://api.openai.com/v1",
);

assert.equal(normalizeChatCompletionsBaseURL(undefined), undefined);
