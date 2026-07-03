// ============================================================
//  第十章 config：路由模块的模型配置
//
//  学习目标：
//  1. 为 router 单独设置较小的 MAX_TOKENS
//  2. 用 temperature=0 提高分类稳定性
//  3. 懒加载 OpenAI 客户端，供 routerAgent 复用
// ============================================================

import OpenAI from "openai";

export const MODEL = "gpt-4o-mini";
export const MAX_TOKENS = 500;
export const TEMPERATURE = 0;
// 路由是分类任务，不需要创造性；稳定比发散更重要。

let _client: OpenAI | null = null;
// 缓存客户端，避免每次 runRouterAgent 都重新创建实例。

export function getClient(): OpenAI {
  if (!_client) {
    _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _client;
}
