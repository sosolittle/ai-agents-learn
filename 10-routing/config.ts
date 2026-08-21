// ============================================================
//  第十章 config：路由模块的模型配置
//
//  🏠 生活化比喻：
//  分诊台和诊室用的是同一台「医院总机」（同款模型），但话务
//  配置不同：分诊只需要一句话答案（MAX_TOKENS=500，比第九章
//  1500 小得多），而且必须零随机（temperature=0）——
//  同一个病人今天分内科、明天分外科，是要出事故的。
//
//  学习目标：
//  1. 为 router 单独设置较小的 MAX_TOKENS
//  2. 用 temperature=0 提高分类稳定性
//  3. 懒加载 OpenAI 客户端，供 routerAgent 复用
// ============================================================

import OpenAI from "openai";

export const MODEL = "gpt-4o-mini";
// 分类任务的输出是一小段 JSON（几十个 token 就够）。
// 上限给 500 已是宽裕——小上限还能防止模型「话痨」跑偏。
export const MAX_TOKENS = 500;
export const TEMPERATURE = 0;
// 路由是分类任务，不需要创造性；稳定比发散更重要。

let _client: OpenAI | null = null;
// 缓存客户端，避免每次 runRouterAgent 都重新创建实例。
// 懒加载单例，同第九章 config.ts 的讲法（第一次真用才创建）。

export function getClient(): OpenAI {
  if (!_client) {
    _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _client;
}
