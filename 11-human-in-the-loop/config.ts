// ============================================================
//  Configuration：集中管理模型参数和持久化路径
//
//  学习目标：
//  1. 让所有命令使用同一组数据文件，不受启动目录影响
//  2. 延迟创建 OpenAI client，使不调用模型的 CLI/测试无需 API Key
//  3. 用 DataPaths 注入临时路径，提高核心流程的可测试性
// ============================================================

import OpenAI from "openai";
import path from "node:path";
import { fileURLToPath } from "node:url";

// One place for the model settings. Proposing an action is a small,
// deterministic classification job, so the temperature is 0 and the token
// budget is low — the model's output is a typed proposal, not prose.
export const MODEL = "gpt-4o-mini";
export const MAX_TOKENS = 400;
export const TEMPERATURE = 0;

// Resolve the data directory relative to this file, not the current working
// directory, so the CLI commands work the same whether they are run from inside
// the module folder or from the repo root. path.join keeps this correct on
// Windows too.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.join(__dirname, "data");

// The persisted workflow state. Approval records survive process restarts, so a
// pending approval is a durable thing to act on later — not just an in-memory
// readline question.
export interface DataPaths {
  approvals: string;
  audit: string;
  executions: string;
}

/** The committed demonstration stores. Tests inject temporary paths instead. */
export function defaultPaths(): DataPaths {
  return {
    approvals: path.join(DATA_DIR, "approvals.json"),
    audit: path.join(DATA_DIR, "audit-log.json"),
    executions: path.join(DATA_DIR, "executions.json"),
  };
}

let _client: OpenAI | null = null;

export function getClient(): OpenAI {
  // Lazy initialization：只有 proposeAction 真正运行时才读取 OPENAI_API_KEY。
  // approvals/edit/approve/test 都不会因为导入 config.ts 就创建网络客户端。
  if (!_client) {
    _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _client;
}
