
// ============================================================
//  system-vs-user-prompt 极简练习版
//
//  这里只创建一个普通 OpenAI 客户端，方便你在本课中快速试 API。
//  更完整的 system/user prompt 对比逻辑在同目录 index.ts。
//
//  学习目标：
//  1. 复习 dotenv/config 的最简加载方式
//  2. 看懂创建 OpenAI 客户端需要哪些配置
//  3. 为本课其他实验准备一个最小客户端草稿
// ============================================================

import "dotenv/config"
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL
})
// client 当前没有被导出或调用，像是课堂中临时验证环境变量的草稿。
// 保留它可以作为“最小客户端创建示例”参考。
