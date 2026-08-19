// ============================================================
//  第十一章：工具函数（utils.ts）
//  校验边界、JSON 持久化、ID 生成与终端格式化
//
//  学习目标：
//  1. 把"解析 JSON"和"验证业务结构"拆成两个明确步骤，
//     每一步失败时都能给出准确的错误
//  2. 理解 JSON 文件存储的三种状态：
//     文件不存在 / 文件是空的 / 文件损坏 —— 前两个是"空店"，后一个是事故
//  3. 用"最大后缀 + 1"生成永不回退的顺序 ID
//  4. 体会"数据损坏时快速失败"优于"静默重置"的工程原则
//
//  本文件在整个章节中的角色：
//  它是基础设施层，不含任何业务规则。approvalStore、auditLog、
//  actionAgent 都复用这里的函数。把这些抽出来，业务模块就能
//  保持"每行代码都在讲业务"的可读性。
// ============================================================

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
// node:fs 是 Node.js 的文件系统模块，这里用到五个函数：
//   existsSync(path)          → 同步判断文件/目录是否存在
//   mkdirSync(path, {recursive}) → 同步创建目录（recursive 类似 mkdir -p）
//   readFileSync(path, enc)   → 同步读文件
//   writeFileSync(path, data) → 同步写文件（整文件覆盖）
//
// 为什么用 Sync（同步）版本而不是 async 版本？
//   本章节是单进程、单命令的演示程序，每次只做一个文件操作，
//   同步 API 代码更直、错误处理更简单。
//   高并发服务器应该用 fs/promises 避免阻塞事件循环。
//   "根据程序形态选 API"而不是"永远用新潮的"。
import { dirname } from "node:path";
// dirname(path) 取路径的目录部分："a/b/c.json" → "a/b"。
// 写文件前用它确保父目录存在。
import { z } from "zod";
// Zod：运行时校验库。types.ts 里有它的详细介绍。

/**
 * 解析一段"预期符合 Zod Schema"的模型输出。
 * 如果文本不是合法 JSON、或不符合 Schema，抛出带标签的清晰错误，
 * 让一个坏提案在边界处就大声失败。
 */
export function safeJsonParse<T>(
  raw: string,
  label: string,
  schema: z.ZodType<T>
): T {
  // 泛型 <T> 的作用：
  //   调用方传入一个 schema，函数返回"该 schema 校验通过后的类型"。
  //   safeJsonParse(raw, "Agent", ActionProposalSchema)
  //   的返回值自动是 ActionProposal 类型，不需要调用方再断言。
  //   这是"类型跟着数据走"——Schema 决定类型，而不是人手写类型。
  //
  // 参数说明：
  //   raw    → 模型返回的原始文本
  //   label  → 错误消息里的来源标签（如 "Action Proposal Agent"），
  //            多个 agent 时能一眼看出是谁的输出坏了
  //   schema → 用来校验解析结果的 Zod Schema

  // parsed 必须先保持 unknown；只有通过 schema 后才能成为 T。
  // 直接写 `JSON.parse(raw) as T` 只是在骗过编译器，没有运行时保护。
  let parsed: unknown;
  // unknown 和 any 的区别（第一章提过，这里再强调一次）：
  //   any  → "什么都不是，也什么都是"——编译器放弃检查，
  //           你可以随便对它调方法、取字段，编译器一言不发。
  //   unknown → "不知道是什么"——编译器强制你先收窄类型才能用。
  //             直接 parsed.foo 会编译报错，
  //             必须先经过类型守卫或 Schema 校验。
  //   外部输入一律 unknown + 显式校验，这是 agent 代码的安全底线。
  try {
    parsed = JSON.parse(raw);
    // JSON.parse 只保证"是合法 JSON"，不保证结构。
    // "{}"、"[1,2,3]"、"\"hello\"" 都能解析成功。
  } catch {
    // catch 不带参数是现代 JS 写法（catch (e) 但不用 e 时可省略）。
    // JSON.parse 抛 SyntaxError 时，我们换成自己的、带上下文的错误。
    throw new Error(
      `${label} did not return valid JSON. Got:\n${preview(raw, 200)}`
    );
    // 错误消息三要素：谁（label）、出了什么问题（not valid JSON）、
    // 原文是什么（preview 截断到 200 字符）。
    // 没有原文的解析错误几乎无法排查。
  }

  const result = schema.safeParse(parsed);
  // safeParse vs parse：
  //   parse(data)     → 校验失败直接抛 ZodError
  //   safeParse(data) → 返回 { success: true, data } 或
  //                     { success: false, error }，不抛错
  // 这里用 safeParse 是因为想自己组织错误消息的格式。
  if (!result.success) {
    throw new Error(
      `${label} returned invalid shape.\n${result.error.toString()}\nRaw:\n${preview(raw, 200)}`
    );
    // result.error 是 ZodError，toString() 会列出每个失败字段的
    // 路径和原因（Zod 的报错是"全部问题一起说"，不是一次只说一个）。
  }

  return result.data;
  // 到这里 TypeScript 已经知道 result 是"成功的那一半"，
  // result.data 的类型就是 T——经过校验的安全数据。
}

/**
 * 从磁盘读取一个 JSON 数组存储。
 *
 * - 文件不存在 → 视为空存储（返回 []）
 * - 文件是空文件 → 视为空存储（返回 []）
 * - JSON 格式损坏 → 抛出清晰的带标签错误，而不是静默重置数据
 *   —— 悄悄丢掉审计记录比报错更糟
 * - 解析结果会用条目 Schema 逐条校验
 */
export function readJsonArray<T>(
  filePath: string,
  schema: z.ZodType<T>,
  label: string
): T[] {
  // 缺失文件表示"尚无数据"，但已存在却损坏的文件表示真实故障；
  // 两者不能都返回 []，否则会静默丢失审批和审计历史。
  //
  // 想象 approvals.json 存着一张 pending 审批单：
  //   文件被误删 → 返回 [] → 程序继续跑 → 审批单"消失"了
  //   文件损坏   → 返回 [] → 程序继续跑 → 审批历史"消失"了
  // 第二种情况用户根本不知道发生了什么。
  // "宁可崩溃得明明白白，不要成功得不明不白。"
  if (!existsSync(filePath)) return [];

  const raw = readFileSync(filePath, "utf8").trim();
  // trim() 去掉首尾空白。这样"只包含换行的文件"也当作空文件处理。
  if (raw === "") return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `${label} store at ${filePath} contains malformed JSON. ` +
        `Fix it by hand or restore a clean state with "npm run reset".`
    );
    // 错误消息里直接给出恢复路径（npm run reset），
    // 这是"可操作的错误消息"：不但说哪里坏了，还说接下来能怎么办。
  }

  const result = z.array(schema).safeParse(parsed);
  // z.array(schema)：把"单条校验器"升级成"数组校验器"，
  // 每个元素都要过 schema，且顶层必须真的是数组。
  // 这一步能拦住"JSON 合法但结构不对"的情况：
  //   比如手改文件时把数组改成了对象、给某条记录改错了状态名。
  if (!result.success) {
    throw new Error(
      `${label} store at ${filePath} has an invalid shape.\n${result.error.toString()}`
    );
  }

  return result.data;
}

/** 把一个 JSON 数组存储以格式化 JSON 写入磁盘，需要时自动创建目录。 */
export function writeJsonArray<T>(filePath: string, items: T[]): void {
  // 统一格式化并补换行，让持久化文件可以直接阅读和进行 git diff。
  //
  // 两个缩进 + 末尾换行的细节：
  //   JSON.stringify(items, null, 2) → 2 空格缩进，人能直接读；
  //   末尾补 "\n" → 符合 POSIX 文件"以换行结尾"的惯例，
  //   git diff / cat 不会显示 "\ No newline at end of file"。
  // 学习型项目把数据文件当文档对待；
  // 生产系统换数据库后这些问题自然消失。
  mkdirSync(dirname(filePath), { recursive: true });
  // recursive: true 类似 mkdir -p：一次性创建多级缺失目录，
  // 已存在也不报错。首次运行时 data/ 目录就是这么建出来的。
  writeFileSync(filePath, `${JSON.stringify(items, null, 2)}\n`, "utf8");
  // 注意 writeFileSync 是整文件覆盖写。
  // "读数组 → 改 → 写回整个数组"是本章节的持久化模式，
  // 简单但不是原子操作：写到一半断电会留下半个文件。
  // 生产环境需要原子写（写临时文件 + rename）或数据库事务，
  // README 的 Production notes 有展开。
}

/**
 * 为一个前缀生成下一个确定性顺序 ID（例如 "APR" → "APR-001"）。
 * 从"已存在的最大后缀"推导，这样 ID 稳定且永不冲突，
 * 即使中间有一些记录被删掉了。
 */
export function nextSequentialId(prefix: string, existingIds: string[]): string {
  // 取最大后缀而不是数组长度：即使中间记录被移除，也不会重用旧 ID。
  //
  // 反例——用数组长度：
  //   已有 APR-001, APR-002, APR-003，删掉 APR-002
  //   长度 = 2 → 生成 APR-003 → 和现存 APR-003 冲突！
  // 用最大后缀：
  //   最大后缀 = 3 → 生成 APR-004 → 永远安全
  //
  // 为什么顺序 ID 而不是随机 UUID？
  //   演示/教学场景里，APR-001 → EXE-001 → REF-001 的对应关系
  //   人一眼能看懂，README 的输出示例也能逐行对上。
  //   生产系统更常用 UUID（全局唯一、不泄露业务量）。
  //   这是"演示优先可读性、生产优先健壮性"的一次取舍。
  const pattern = new RegExp(`^${prefix}-(\\d+)$`);
  // 动态构造正则：前缀拼进模式里。
  //   \\d+ 在字符串里写成 \\d，因为 \ 在字符串里本身要转义。
  //   括号 () 是捕获组：match[1] 就是后缀数字部分。
  let max = 0;
  for (const id of existingIds) {
    const match = id.match(pattern);
    // 不匹配 pattern 的 ID（理论上不该有）直接跳过，
    // 不让它打断 ID 生成。
    if (match) max = Math.max(max, Number.parseInt(match[1], 10));
    // Number.parseInt(str, 10)：第二参数 10 显式指定十进制。
    // 不传时老代码可能把 "0x..." 当十六进制，养成显式写的习惯。
  }
  return `${prefix}-${String(max + 1).padStart(3, "0")}`;
  // padStart(3, "0")：不足 3 位左侧补零 → 1 变 "001"。
  // 这样 APR-001 / APR-010 / APR-100 字典序 == 数值序，
  // 排序、对齐、肉眼比较都舒服。
}

/** 当前时间的 ISO 字符串，用于 createdAt/updatedAt/timestamp。 */
export function nowIso(): string {
  return new Date().toISOString();
  // toISOString() 格式固定为 "2026-08-18T09:30:00.000Z"（UTC）。
  // 为什么不用本地时间字符串？
  //   ISO-8601 + UTC 是跨时区、跨机器排序最不容易出错的格式；
  //   本地时间受时区和夏令时影响，比较时容易踩坑。
}

/** 打印一个带标签的章节标题，让每个阶段在终端里容易分辨。 */
export function printSection(title: string): void {
  const line = "─".repeat(Math.max(title.length, 12));
  // "─".repeat(n)：把制表符线重复 n 次。
  // Math.max(title.length, 12)：标题太短时至少画 12 个字符宽，
  // 避免 "Reset" 这种短标题上面只有一条 5 字符的小线。
  console.log(`\n${line}\n${title}\n${line}`);
  // 输出效果：
  //   ────────────
  //   Reset
  //   ────────────
  // 前面空一行分隔上一节内容。
}

/** 把值格式化成带缩进的 JSON，用于终端展示。 */
export function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
  // 和 writeJsonArray 里同一个格式化调用；
  // 单独导出一个函数是为了语义清楚："我要打印给人看"。
}

/** 截断长文本，用于预览和错误消息。 */
export function preview(value: unknown, max = 140): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  // 预览的对象可能是字符串也可能不是：
  //   字符串 → 直接用
  //   其他   → JSON 序列化后用
  return text.length <= max ? text : `${text.slice(0, max)}...`;
  // 超长就截断加省略号。
  // 用在错误消息里防止模型输出 5000 字的"坏 JSON"刷屏终端。
}

// ============================================================
//  本文件小结
// ============================================================
//
// 三个值得带走的工程判断：
//
// 1. "文件不存在"和"文件损坏"是两种完全不同的情况：
//    前者返回空数组是合理的（还没有数据），
//    后者返回空数组是危险的（假装数据从未存在）。
//
// 2. 顺序 ID 用"最大后缀 + 1"，不用"数组长度 + 1"——
//    删除记录后后者会生成重复 ID。
//
// 3. 错误消息要"可操作"：说清谁错了、错在哪、怎么恢复
//    （safeJsonParse 带 label 和原文预览，readJsonArray 提示 npm run reset）。
// ============================================================
