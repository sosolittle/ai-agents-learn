// ============================================================
//  第九章 knowledge：本地知识库（工匠的资料柜）
//
//  🏠 生活化比喻：
//  工匠（Worker Agent）动工前，先发他一间资料柜：推荐的
//  MVP 功能清单、技术栈建议、常见坑、示例接口和数据模型。
//  要求他「照着资料做，别自由发挥」——这就是 grounding
// （接地/落地）：让模型基于给定材料工作，而不是凭记忆
//  现编一套架构。资料柜是本地的、写死的、离线可用；
//  真实系统里它可能换成 wiki、设计文档、向量库或内部 API。
//
//  学习目标：
//  1. 理解 grounding：让模型基于给定资料回答，而不是自由发挥
//  2. 用 typed object 保存可复用的工程建议
//  3. 把结构化知识转换成 prompt 友好的纯文本
// ============================================================

// A small mock knowledge base — no external APIs.
//
// This is what grounds the Worker Agent. Instead of inventing an architecture
// from nothing, the worker is handed concrete, local engineering guidance and
// asked to stay within it. In a real system this might come from a wiki, a
// design-system doc, a vector store, or an internal API. Here it is just a
// typed object so the example stays runnable offline.

// as const：把所有字段冻结成字面量类型（第八章讲过）。
// 知识条目是静态事实，冻结后既防误改，也让类型精确。
export const knowledge = {
  recommendedMvpFeatures: [
    "create and name a habit",
    "mark a habit complete for a given day",
    "view a simple streak count per habit",
    "see today's habits in one list",
  ],
  stackRecommendation: {
    frontend: "React with TypeScript",
    backend: "Node.js with a small REST API",
    database: "SQLite or Postgres",
    auth: "email + password to start, or a single-user mode for the MVP",
  },
  commonRisks: [
    "scope creep from social and gamification features",
    "over-engineering reminders and notifications too early",
    "timezone bugs when computing streaks",
    "syncing across devices before there is a single working flow",
  ],
  exampleApiEndpoints: [
    "POST /habits — create a habit",
    "GET /habits — list habits",
    "POST /habits/:id/checkins — mark a habit done for a day",
    "GET /habits/:id/streak — return the current streak",
  ],
  exampleDataModel: [
    "User: id, email, created_at",
    "Habit: id, user_id, name, created_at",
    "CheckIn: id, habit_id, date, created_at",
  ],
} as const;

/** Render the knowledge base as plain text for inclusion in a prompt. */
export function knowledgeAsText(): string {
  // 把对象格式转换成普通文本，方便直接塞进 prompt。
  // 当前 workerAgent 使用 JSON.stringify(knowledge)，这个函数展示另一种可读格式。
  //
  // TS 语法：数组字面量里混用 ...spread 和普通项——
  //   ["标题", ...条目.map(加破折号), "", "下一个标题", …]
  // spread 把子数组的元素平铺进大数组；"" 是空行分隔符。
  // 最后 join("\n") 拼成整段文本。这是「结构化数据 → 可读文本」
  // 的惯用三板斧：map 转格式、spread 平铺、join 收尾。
  return [
    "Recommended MVP features:",
    ...knowledge.recommendedMvpFeatures.map((f) => `- ${f}`),
    "",
    "Suggested stack:",
    `- frontend: ${knowledge.stackRecommendation.frontend}`,
    `- backend: ${knowledge.stackRecommendation.backend}`,
    `- database: ${knowledge.stackRecommendation.database}`,
    `- auth: ${knowledge.stackRecommendation.auth}`,
    "",
    "Common risks:",
    ...knowledge.commonRisks.map((r) => `- ${r}`),
    "",
    "Example API endpoints:",
    ...knowledge.exampleApiEndpoints.map((e) => `- ${e}`),
    "",
    "Example data model entities:",
    ...knowledge.exampleDataModel.map((e) => `- ${e}`),
  ].join("\n");
}
