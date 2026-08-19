// ============================================================
//  第十一章：配置中心（config.ts）
//  集中管理模型参数、客户端创建和持久化文件路径
//
//  学习目标：
//  1. 理解"配置集中"：为什么模型名、数据路径只在一个文件定义
//  2. 掌握延迟初始化（lazy init）：让不调模型的命令不需要 API Key
//  3. 学会用 DataPaths 依赖注入隔离演示数据与测试数据
//  4. 理解 ESM 下 __dirname 的正确写法（没有它路径会跟着启动目录漂移）
//
//  本文件在整个章节中的角色：
//  它是唯一的"环境相关"文件。其他模块从不直接读 process.env、
//  从不拼接数据文件路径——它们只 import 这里的常量和函数。
//  想换模型、换数据目录、换 API Key，只改这一个文件（或 .env）。
// ============================================================

import OpenAI from "openai";
// OpenAI 官方 SDK。第一章详细介绍过它的用法；
// 这里只用来创建一个客户端实例供 actionAgent 使用。
import path from "node:path";
// node:path 是 Node.js 内置的路径工具模块。
// 前缀 "node:" 是显式标明"这是内置模块"，避免和 npm 包重名混淆。
import { fileURLToPath } from "node:url";
// fileURLToPath 把 file:// URL 转成普通文件路径。
// 它在 ESM 里被用来推导"当前源文件所在目录"——下面细说。

// 模型设置集中在一处。提案动作是一个小型、确定性的分类任务，
// 所以 temperature 用 0、token 预算给得很低——
// 模型的输出是一个类型化提案，不是散文。
export const MODEL = "gpt-4o-mini";
// gpt-4o-mini：便宜、快，对"从四个工具里选一个并填参数"这种任务足够。
// 模型选择的原则（第一章讲过）在这里再次适用：
//   任务越简单、输出越结构化 → 越不需要大模型。
//   提案 agent 只做单步分类，用最便宜的模型是合理默认。
export const MAX_TOKENS = 400;
// 输出预算 400 token。提案 JSON 大约 100~150 token，
// 400 留了 2~3 倍余量，既不会截断，也不会让模型写起小作文。
// 如果 finish_reason 是 "length"，说明被截断了——
// 但对这个任务来说 400 几乎不可能用完。
export const TEMPERATURE = 0;
// temperature: 0 → 尽可能确定性输出。
//
//   直观理解：temperature 越低，模型选词时的概率分布越"尖"，
//   每次都倾向选同一个词，输出越稳定。
//
// 为什么这里要 0？
//   提案是"理解请求 → 选工具 → 填参数"的任务，有近似标准的答案。
//   temperature 高会让同样的请求每次提出不同参数组合，
//   增加审批人的阅读负担，也让测试不可重复。
//   而创意写作、头脑风暴这类任务才适合调高 temperature。
//
// 注意：即使 temperature=0，模型输出也不是 100% 确定
// （服务商侧的实现可能有微小差异），所以下游仍要靠 Zod 兜底。

// 把数据目录解析为"相对本源文件"而不是"相对当前工作目录"，
// 这样无论从模块目录里运行还是从仓库根目录运行，CLI 命令的行为都一致。
// path.join 也能保证在 Windows 上拼接出正确的分隔符。
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 这三行是 ESM（ES Modules）下推导 __dirname 的惯用法：
//
//   1. import.meta.url → 当前源文件的 file:// URL
//      例如 "file:///Users/you/repo/11-human-in-the-loop/config.ts"
//   2. fileURLToPath(...) → 转成普通路径
//      "/Users/you/repo/11-human-in-the-loop/config.ts"
//   3. path.dirname(...) → 去掉文件名，留下目录
//      "/Users/you/repo/11-human-in-the-loop"
//
// 为什么需要它？
//   CommonJS（老模块系统）自带 __dirname 全局变量；
//   ESM 刻意移除了它，必须像这样手动推导。
//
// 为什么不直接写 "./data"？
//   相对路径是相对 process.cwd()（启动命令所在的目录）解析的。
//   在 11-human-in-the-loop/ 里运行 npm start，"./data" 是 A；
//   在仓库根目录运行 node 11-human-in-the-loop/cli.ts，"./data" 是 B——
//   同样的代码找到两个不同的数据目录，审批单"忽有忽无"。
//   基于源文件位置解析则永远指向同一个地方。
export const DATA_DIR = path.join(__dirname, "data");
// 数据目录：<本文件所在目录>/data。
// approvals.json / executions.json / audit-log.json 都放在这里。

// 持久化的工作流状态。审批记录要在进程重启后依然存在，
// 所以一张 pending 审批单是一个"以后可以处理"的持久事物——
// 而不只是一个内存里的 readline 提问。
//
// 这句话点出了本章和"控制台问答式审批"的本质区别：
//   初学者实现 human-in-the-loop 常用 readline：
//     程序跑到一半 → 控制台问"同意吗 y/n?" → 等人输入
//   问题：进程一退出（或崩了），等待状态就没了；
//   审批人不在电脑前，程序就只能干等。
//   本章的做法：把"等待人类"持久化成一条 pending 记录，
//   当前进程可以立刻退出；几天后由另一个进程（CLI）接着处理。
//   "暂停并等人"从内存问题变成了存储问题。
export interface DataPaths {
  approvals: string;
  // 审批记录文件路径（工作流状态）。
  audit: string;
  // 审计日志文件路径（只追加时间线）。
  executions: string;
  // 执行记录文件路径（已发生的事实）。
}

/** 演示用的正式数据存储。测试会注入临时路径代替。 */
export function defaultPaths(): DataPaths {
  // 为什么是一个函数而不是一个顶层对象？
  //   1. 每次调用返回新对象，调用方改字段不会污染其他使用方；
  //   2. 和测试里的 tempPaths() 形成统一接口——
  //      业务代码要路径，一律"给我一个 DataPaths"，
  //      不关心它来自默认目录还是临时目录。
  //      这就是依赖注入（Dependency Injection）的最小形态：
  //      "需要什么"由接口声明，"具体是什么"由调用方决定。
  return {
    approvals: path.join(DATA_DIR, "approvals.json"),
    audit: path.join(DATA_DIR, "audit-log.json"),
    executions: path.join(DATA_DIR, "executions.json"),
  };
}

let _client: OpenAI | null = null;
// 模块级缓存变量。初始为 null，表示"客户端还没创建过"。
// 类型 OpenAI | null 而不是 OpenAI：
// 强迫使用方处理"还没初始化"的情况，编译器会盯着一举一动。

export function getClient(): OpenAI {
  // Lazy initialization（延迟初始化）：
  // 只有 proposeAction 真正运行时才读取 OPENAI_API_KEY。
  // approvals/edit/approve/test 都不会因为导入 config.ts 就创建网络客户端。
  //
  // 对比两种写法：
  //   写法 A（模块顶层立即创建）：
  //     export const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  //     → 任何人 import config.ts 都会执行这行。
  //       跑 npm run approvals / npm test（都不需要模型）时，
  //       也会创建客户端、读取 Key，甚至可能因为缺 Key 打警告。
  //
  //   写法 B（本文件的 lazy 写法）：
  //     首次调用 getClient() 时才创建，之后复用同一个实例。
  //     → 只有 npm start（唯一调模型的命令）才真正需要 .env 里的 Key。
  //
  // "按需付费、按需依赖"——让每个命令只携带它真正需要的环境前提。
  if (!_client) {
    // 如果缓存还是空的，创建一次。
    // 同一个进程内后续调用直接跳过这里，复用实例
    // （客户端内部有连接复用，重复 new 是浪费）。
    _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    // apiKey 从环境变量读取（.env 由 dotenv 加载）。
    // 为什么不在这里给默认值/硬编码？见第一章的安全说明：
    // Key 进代码 = 进 Git = 进 GitHub = 泄漏。
  }
  return _client;
}

// ============================================================
//  本文件小结
// ============================================================
//
// 三个可复用的配置技巧，任何 agent 项目都用得上：
//
// 1. 配置集中：模型名/路径/预算只在 config.ts 出现一次，
//    其他模块一律 import，避免"改了三处漏了第四处"。
//
// 2. 路径锚定源文件：fileURLToPath(import.meta.url) 推导 __dirname，
//    数据文件位置不随启动目录漂移。
//
// 3. 延迟创建昂贵资源：网络客户端、数据库连接池都应该 lazy，
//    让"不用它们的代码路径"不背上"配置它们的负担"。
// ============================================================
