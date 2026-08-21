// ============================================================
//  第十二章：配置中心（config.ts）
//  数据路径与演示输入——注意：本章没有任何模型配置
//
//  🏠 生活化比喻：开演前的「道具桌」。桌上只有两样东西：
//  三个 JSON 文件的位置（白板 / 发票簿 / 录像带各放哪），
//  以及那张从第 11 章递过来的、已签字的批条
//  （DEMO_APPROVED_ACTION）。注意桌上没有"剧本生成器"——
//  本章没有模型，戏是排好的，随时可以离线重演。
//
//  学习目标：
//  1. 理解"本章为什么没有 API Key"——
//     持久执行是应用运行时的问题，不是提示词能解决的
//  2. 复用第 11 章的三个配置技巧（集中/锚定/注入）
//  3. 认识 DEMO_APPROVED_ACTION：两章之间的"交接棒"
//
//  本文件在整个章节中的角色：
//  它小得刻意。没有模型名、没有 temperature、没有 client——
//  本章的一切（包括 npm start）都可以离线运行。
//  这种"从配置就能看出章节性质"的简洁本身就是一个信号。
// ============================================================

import path from "node:path";
// 内置路径模块（11 章的 config.ts 详解过用法）。
import { fileURLToPath } from "node:url";
// file:// URL → 文件路径的转换器。

import type { ApprovedAction } from "./types.js";
// 只导入类型：DEMO_APPROVED_ACTION 的类型标注需要它。

// 把数据目录解析为"相对本源文件"而不是"相对当前工作目录"，
// 这样无论从模块目录里运行还是从仓库根目录运行，
// CLI 命令的行为都一致。
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// ESM 下推导 __dirname 的惯用三步（与 11 章相同）：
//   import.meta.url → fileURLToPath → path.dirname
// 细节和"为什么不用 ./data 相对路径"见 11-human-in-the-loop/config.ts。
export const DATA_DIR = path.join(__dirname, "data");
// workflows.json / effects.json / events.json 的家。

// 持久化的 checkpoint、effect 账本和事件日志。测试会注入
// 临时路径，这样提交的演示文件永远不会被碰。
export interface DataPaths {
  workflows: string;
  // checkpoint 存储（"走到哪了"）。
  effects: string;
  // 幂等账本（"做没做过"）。
  events: string;
  // 事件日志（"过程如何"）。
}
// 三个路径正好对应本章的三个 store，也正好对应
// types.ts 小结里的"两本账 + 一份时间线"。

/** 提交在仓库里的演示 store。 */
export function defaultPaths(): DataPaths {
  // 返回函数而不是常量的理由与 11 章相同：
  // 每次新对象 + 与测试的 tempPaths() 构成统一的注入接口。
  return {
    workflows: path.join(DATA_DIR, "workflows.json"),
    effects: path.join(DATA_DIR, "effects.json"),
    events: path.join(DATA_DIR, "events.json"),
  };
}

// 第 12 章从这里开始：第 11 章已经批准的那笔退款。
// 本模块没有任何模型调用——持久执行开始于一个提案
// 已被上一个控制层授权之后。
export const DEMO_APPROVED_ACTION: ApprovedAction = {
  // 这个常量就是"交接棒"的实物：
  //
  //   第 11 章：模型提案 refundOrder(79) → 人工编辑为 49 → 人工批准
  //             ↓ 产出一张 approved 的审批单
  //   本章：    拿着这张单开始执行，并让执行过程能活过崩溃
  //
  // amount 是 49 不是 79：README 的故事线里审核人改成了部分退款。
  // approvalId "APR-001" 与 11 章的第一张单编号一致——
  // 两章的演示数据在故事上是连续的。
  approvalId: "APR-001",
  status: "approved",
  // 已批准。注意 createWorkflow 并不盲信这个 "approved"——
  // validate_approval 步骤会重查（业务规则在 steps.ts）。
  toolName: "refundOrder",
  arguments: {
    orderId: "ORD-001",
    amount: 49,
    currency: "EUR",
    reason: "Partial refund approved after review",
    // "复核后批准的部分退款"——理由本身就是 11 章故事的尾声。
  },
};

// ============================================================
//  本文件小结
// ============================================================
//
// 对比 11 章 config.ts，本章少了什么、说明了什么：
//
// | 配置项         | 11 章 | 12 章 | 说明                          |
// |---------------|-------|-------|-------------------------------|
// | MODEL         | ✔     | ✘     | 本章零模型调用                 |
// | TEMPERATURE   | ✔     | ✘     | 没有生成，无所谓稳定性         |
// | getClient()   | ✔     | ✘     | 不需要 API Key，全部离线可跑   |
// | DEMO 输入      | 请求文本| 已批准动作 | 输入形态从"人话"变"凭证" |
//
// "持久执行属于应用运行时，不属于 prompt。"
// 本章的每个 npm 命令（包括 start）都不联网。
// ============================================================
