// ============================================================
//  第九章 config：模型配置与客户端懒加载
//
//  🏠 生活化比喻：
//  三个岗位共用一间「设备间」：统一的模型、温度、输出上限，
//  还有一台共用的 OpenAI 客户端。谁要用都来 getClient() 领，
//  第一次领的时候才开机（懒加载），之后大家复用同一台——
//  不必每个 agent 文件都自购一台 new OpenAI(...)。
//
//  学习目标：
//  1. 把模型名、token 上限、temperature 放到统一配置里
//  2. 用 getClient() 延迟创建 OpenAI 客户端
//  3. 避免每个 agent 文件重复 new OpenAI(...)
// ============================================================

import OpenAI from "openai";

export const MODEL = "gpt-4o-mini";
// 输出上限 1500 token：结构化 JSON（计划/草稿/审稿）都比较长，
// 留足空间但不无限（省成本、防跑题小作文）。
export const MAX_TOKENS = 1500;
export const TEMPERATURE = 0;
// 多 Agent handoff 更希望稳定和可重复，所以 temperature 设为 0。
// temperature = 采样的随机度：0 ≈ 每次都选最可能的词。
// 同一输入多次运行，产出高度一致——交接链条上任何一环
// 「发挥不稳定」，整条流水线的复现性就没了。

let _client: OpenAI | null = null;
// 模块级缓存。第一次调用 getClient 时创建，之后复用同一个实例。
// 类型 OpenAI | null：null 表示「还没开机」。

export function getClient(): OpenAI {
  // 懒加载单例：if (!_client) 才创建。
  // 两个小讲究：
  //  ① 懒——模块被 import 时不立刻连 API，第一次真用才创建
  //    （import config 不会产生副作用，测试更友好）；
  //  ② 单例——之后所有 agent 复用同一个实例，不重复占用。
  if (!_client) {
    _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _client;
}
