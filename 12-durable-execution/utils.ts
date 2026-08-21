// ============================================================
//  第十二章：工具函数（utils.ts）
//  JSON 持久化、ID 生成与终端格式化
//
//  🏠 生活化比喻：后台的「水电工工具箱」——和 11 章同一套扳手
//  （JSON 读写、编号机、格式化打印），只是少了一把
//  "解析模型输出"的螺丝刀：本章没有模型，用不上它。
//  工具箱越眼熟越好：基础设施不变，注意力才能全给新概念。
//
//  学习目标：
//  1. 复用第 11 章打磨过的 JSON 存储模式（三态处理、
//     快速失败、读时校验）
//  2. 观察两个章节的工具层几乎相同——
//     这是刻意的：基础设施稳定后，新章节只需专注新概念
//
//  本文件在整个章节中的角色：
//  纯基础设施，零业务逻辑。与 11 章的 utils.ts 的差别只有：
//  删掉了 safeJsonParse（本章没有模型输出要解析）。
//  少的那一个函数本身就是本章性质的注脚：
//  没有模型，就没有"不可信文本输入"这道边界要守。
// ============================================================

// 全模块共享的小工具：JSON 文件持久化、ID 生成和终端格式化。
// 这里没有模型输出要解析——本模块零 OpenAI 调用。
// （对比 11 章 utils.ts：那边第一个函数就是 safeJsonParse，
//  因为那边有模型；这边没有，所以没有。）

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
// 同步文件 API（选择 Sync 版本的理由见 11 章 utils.ts）。
import { dirname } from "node:path";
import { z } from "zod";

/**
 * 从磁盘读取一个 JSON 数组存储。
 *
 * - 文件不存在 → 视为空存储（返回 []）
 * - 空文件 → 视为空存储（返回 []）
 * - JSON 损坏 → 抛出清晰的带标签错误而不是静默重置——
 *   悄悄丢失 checkpoint 或账本历史比报错更糟
 * - 解析结果会用条目 Schema 逐条校验
 */
export function readJsonArray<T>(
  filePath: string,
  schema: z.ZodType<T>,
  label: string
): T[] {
  // 泛型三参数（路径 / Schema / 标签）与 11 章完全一致；
  // "文件缺失 ≠ 文件损坏"的三态语义也完全一致：
  //
  //   checkpoint 丢了 = 工作流从头再跑（幂等键保住副作用）
  //   账本丢了       = 幂等保护消失，重跑会重复副作用——灾难
  //   所以"损坏当空"对账本尤其不可接受，必须报错。
  if (!existsSync(filePath)) return [];

  const raw = readFileSync(filePath, "utf8").trim();
  if (raw === "") return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `${label} store at ${filePath} contains malformed JSON. ` +
        `Fix it by hand or restore a clean state with "npm run reset".`
    );
    // 和 11 章同款"可操作错误"：告诉用户可以用 npm run reset 恢复。
  }

  const result = z.array(schema).safeParse(parsed);
  // z.array(schema)：单条校验器 → 数组校验器。
  // 对本章而言这一步多了一层意义：types.ts 的 superRefine
  // 就是在这里被触发的——损坏的 checkpoint（乱序步骤、
  // 谎报完成）在"读取"这一刻被拦截，永远到不了恢复逻辑。
  if (!result.success) {
    throw new Error(
      `${label} store at ${filePath} has an invalid shape.\n${result.error.toString()}`
    );
  }

  return result.data;
}

/** 把一个 JSON 数组存储以格式化 JSON 写入磁盘，需要时自动建目录。 */
export function writeJsonArray<T>(filePath: string, items: T[]): void {
  // 格式化 + 末尾换行的理由与 11 章相同：
  // data/*.json 可以直接阅读、git diff 友好。
  // 你现在打开 data/workflows.json 就能"肉眼检查 checkpoint"——
  // 这对本章尤其有价值：教学核心就是这两份持久化数据。
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(items, null, 2)}\n`, "utf8");
}

/**
 * 为一个前缀生成下一个确定性顺序 ID（例如 "WF" → "WF-001"）。
 * 从已存在的最大后缀推导，这样 ID 稳定且永不冲突，
 * 即使有些记录被移除了。
 */
export function nextSequentialId(prefix: string, existingIds: string[]): string {
  // "最大后缀 + 1"算法（不用"长度 + 1"）的理由见 11 章 utils.ts：
  // 删除中间记录后仍不重号。
  const pattern = new RegExp(`^${prefix}-(\\d+)$`);
  let max = 0;
  for (const id of existingIds) {
    const match = id.match(pattern);
    if (match) max = Math.max(max, Number.parseInt(match[1], 10));
  }
  return `${prefix}-${String(max + 1).padStart(3, "0")}`;
  // 本章的前缀：WF（工作流）、REF（退款）、MSG（消息）。
}

/** 当前时间的 ISO 字符串，用于 createdAt/updatedAt/timestamp。 */
export function nowIso(): string {
  return new Date().toISOString();
  // UTC ISO-8601：跨时区排序最安全的格式（同 11 章）。
}

/** 打印一个带标签的章节标题，让每个阶段在终端里容易分辨。 */
export function printSection(title: string): void {
  const line = "─".repeat(Math.max(title.length, 12));
  console.log(`\n${line}\n${title}\n${line}`);
}

/** 把值格式化成带缩进的 JSON，用于终端展示。 */
export function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

// ============================================================
//  本文件小结
// ============================================================
//
// 与 11 章 utils.ts 的 diff 一目了然：
//   删除：safeJsonParse（没有模型输出，不需要）
//   保留：readJsonArray / writeJsonArray / nextSequentialId
//         / nowIso / printSection / prettyJson
//   新增：preview 也删了（它是 safeJsonParse 的报错辅助）
//
// 基础设施的稳定性让学习者可以把全部注意力放在
// effectStore / checkpointStore / workflowRunner 这些新概念上。
// ============================================================
