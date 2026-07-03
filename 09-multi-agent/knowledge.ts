// ============================================================
//  第九章 knowledge：本地知识库
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
