// ============================================================
//  第九章 config：模型配置与客户端懒加载
//
//  学习目标：
//  1. 把模型名、token 上限、temperature 放到统一配置里
//  2. 用 getClient() 延迟创建 OpenAI 客户端
//  3. 避免每个 agent 文件重复 new OpenAI(...)
// ============================================================

import OpenAI from "openai";

export const MODEL = "gpt-4o-mini";
export const MAX_TOKENS = 1500;
export const TEMPERATURE = 0;
// 多 Agent handoff 更希望稳定和可重复，所以 temperature 设为 0。

let _client: OpenAI | null = null;
// 模块级缓存。第一次调用 getClient 时创建，之后复用同一个实例。

export function getClient(): OpenAI {
  if (!_client) {
    _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _client;
}
