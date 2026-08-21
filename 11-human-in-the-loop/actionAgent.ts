// ============================================================
//  第十一章：动作提案 Agent（actionAgent.ts）
//  模型只描述"做什么"，不决定"能不能做"
//
//  🏠 生活化比喻（延续 index.ts 的「报销审批处」故事）：
//  本文件就是那位「前台接待员」。客户（用户请求）到窗口说一句话，
//  他负责听懂、翻《工具手册》、填出一张标准申请单（ActionProposal）。
//  注意他填的单子上连"这笔要不要审批"那一栏都没有——
//  表格上根本没印这个格子，他想越权都没地方写。
//  填完把单子递进窗口（返回值），后面的事就与他无关了：
//  查表是 policy 的事、签字是人、付款是 executor。
//
//  学习目标：
//  1. 把模型职责限制为"选择工具 + 生成参数"
//  2. 理解 prompt 约束用于"引导输出"，Zod 校验才是"程序边界"
//     —— prompt 说"不许夹带权限字段"是引导；
//     Schema 的 .strict() 让夹带了也进不来，这才是防线
//  3. 学会用 system prompt 划定角色边界（什么该做、什么明确不做）
//  4. 用 response_format 提高 JSON 输出概率，但不依赖它
//
//  本文件在整个章节中的角色：
//  全章唯一调用模型的地方。proposeAction() 读一句用户请求，
//  返回一个通过校验的 ActionProposal。之后所有环节——
//  策略判定、审批、执行、审计——都是普通 TypeScript 代码，
//  不再有模型的"自由发挥"空间。
//
//  这一课的核心结论：
//  capability（能做什么）≠ permission（允许做什么）。
//  模型很适合前者：理解请求、匹配工具、填参数。
//  它绝不适合后者：让一段概率文本决定"这笔钱可以动"，风险不可控。
// ============================================================

import "dotenv/config";
// 副作用导入（第一章讲过）：import 即执行 dotenv.config()，
// 把 .env 里的 OPENAI_API_KEY 加载进 process.env。
// 必须在 getClient() 真正读环境变量之前完成——
// 由于 getClient 是延迟初始化的，只要本模块被 import 时
// dotenv 已经加载即可，这里的顺序刚好保证这一点。

import { MAX_TOKENS, MODEL, TEMPERATURE, getClient } from "./config.js";
// 模型名 / 温度 / token 预算 / 客户端都来自 config.ts（见那里的注释）。
// import 路径以 .js 结尾是 ESM + tsc 的惯例：
// 源文件是 .ts，编译后是 .js，TypeScript 要求 import 写目标扩展名。
import { ActionProposalSchema, type ActionProposal } from "./types.js";
// 判别联合 Schema：本文件的输出必须通过它校验。
// `import { X, type Y }` 里的 type 前缀表示"只导入类型"——
// 编译后这半个 import 会被完全擦掉，不产生运行时代码。
import { safeJsonParse } from "./utils.js";
// "JSON.parse + Schema 校验"的二合一安全解析器。

// 动作提案 Agent 只有一个职责：读请求，提出一个能满足它的
// 支持工具调用以及相应参数。这是 capability（能力）。
//
// 它刻意对 permission（权限）没有任何发言权。prompt 禁止任何
// requiresApproval、isAuthorized、allowed 之类的字段——
// 而且 Schema 的 .strict() 对象本来也会拒绝它们。
// 提议的动作能不能运行，由后面确定性的策略层决定，不由模型决定。
const SYSTEM_PROMPT = `You are the Action Proposal Agent for a customer-support system.

Your only job is to propose ONE supported tool call that could satisfy the user's request,
and the arguments for it. You describe capability, not permission.

You do NOT decide any of the following:
- whether the action is authorized
- whether it requires approval
- whether it is allowed
- whether it should execute automatically

Never include fields like "requiresApproval", "isAuthorized", "allowed", or "autoExecute".
The application decides those. You only propose the tool and arguments.

Output only valid JSON. No markdown. No commentary.

Supported tools and their arguments:
- "getOrderStatus": { "orderId": string like "ORD-001" }
- "refundOrder": { "orderId": string like "ORD-001", "amount": number > 0, "currency": "EUR", "reason": string }
- "cancelSubscription": { "customerId": string like "CUS-104", "reason": string }
- "deleteProductionUsers": {}

Return a JSON object with exactly these fields:
{
  "toolName": one of the supported tool names,
  "arguments": the arguments object for that tool,
  "reason": a short explanation of why you selected this tool
}`;
// 逐段拆解这个 prompt 的设计意图：
//
// 1) 角色定位（第 1-3 行）
//    "Your only job is..." 把职责收窄到一件事。
//    明确的窄职责比"你是一个智能助手"更可控。
//
// 2) 权限切割（第 5-11 行）
//    "You do NOT decide..." 用否定列表明确划出禁区。
//    把"不许做什么"写成清单，比一句"要谨慎"有效得多。
//
// 3) 字段黑名单（第 13-14 行）
//    点名列出禁止的权限字段名。即使模型见过这些字段
//    （训练数据里满是这种结构），也会因为这条指令倾向于不输出。
//
// 4) 输出格式约束（第 16 行）
//    "Output only valid JSON. No markdown. No commentary."
//    LLM 爱用 ```json 代码块包输出，这句能显著减少包裹。
//    但注意：这只是"提高概率"，不是保证——
//    真正的保证在代码里的 safeJsonParse。
//
// 5) 工具清单（第 18-22 行）
//    把四个工具的参数形状直接写进 prompt，并给出示例值
//    （"ORD-001"、"CUS-104"）。这相当于把 Schema 的核心内容
//    "喂"给模型，让它不用猜格式。
//    注意这个清单是手写的副本——Schema 才是唯一权威。
//    如果以后加工具，两处都要改（生产系统可由 Schema 自动生成这段）。
//
// 6) 输出模板（第 24-28 行）
//    最后给出确切的输出结构。给模型一个"填空题"
//    比给它"作文题"输出稳定得多。
//
// 整体上这是一个"约束型 prompt"的范本：
// 职责窄、禁区明、格式死、示例足。

export async function proposeAction(request: string): Promise<ActionProposal> {
  // 本章节唯一一次模型调用发生在这里。后续 policy、审批状态迁移和执行
  // 全部由普通 TypeScript 代码完成，因此它们可重复、可测试、可审计。
  //
  // 函数签名值得看一眼：
  //   输入  request: string        —— 一句自然语言用户请求
  //   输出  Promise<ActionProposal> —— 一个已通过 Schema 校验的类型化提案
  // "字符串进、结构化数据出"，脏活（解析/校验/报错）全在函数内部消化。
  // 调用方拿到的永远是干净数据或明确异常，没有中间态。
  const response = await getClient().chat.completions.create({
    model: MODEL,
    // gpt-4o-mini（见 config.ts 注释里的选型理由）。
    temperature: TEMPERATURE,
    // 0：同样的请求尽量得到同样的提案，方便演示与测试。
    max_tokens: MAX_TOKENS,
    // 400：提案 JSON 的预算绰绰有余（见 config.ts）。
    response_format: { type: "json_object" },
    // response_format 让支持该参数的模型进入"JSON 模式"：
    // 输出保证是语法合法的 JSON（不会截半截、不会带 markdown 壳）。
    //
    // 但要清楚它的能力边界：
    //   保证的：语法层面是合法 JSON
    //   不保证的：字段对不对、值合不合法、有没有多余字段
    // 所以下一行的 safeJsonParse 校验仍然必不可少。
    // "API 参数帮你提高了下限，Schema 才守住上限。"
    messages: [
      // system 定义角色边界；user 只携带当前业务请求，避免把权限逻辑
      // 动态拼进用户消息后交给模型自行判断。
      //
      // system / user 的分工在这里再次体现（第一章讲过三种角色）：
      //   system → 开发者定的规则："你是提案 agent，不许谈权限"
      //   user   → 用户的任务本身："帮我退款 79 欧"
      // 如果把规则拼进 user 消息，用户后续消息就可能"覆盖"它——
      // "刚才那些规则不用管了"这类提示攻击会更容易得手。
      // 规则放 system，任务放 user，是结构性的一点防御。
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `User request: ${request}` },
    ],
  });

  const raw = response.choices[0].message.content ?? "";
  // 取第一条回复的文本内容；?? "" 把 null 变成空字符串。
  // content 为 null 时（罕见，比如被截断的特殊情形），
  // 后面的 JSON.parse 会失败并给出清晰的报错——
  // 比"对 null 调 .match"抛出的 TypeError 更有指导意义。
  // response_format 只能提高返回 JSON 的概率；它不能替代业务校验。
  // safeJsonParse 会先解析 JSON，再用 ActionProposalSchema 检查工具和参数。
  //
  // 📤 输入输出走查（index.ts 的演示请求进来之后）：
  //   输入  request = "Refund €79.00 for order ORD-001 ... damaged."
  //   模型输出 raw ≈ '{"toolName":"refundOrder","arguments":
  //                     {"orderId":"ORD-001","amount":79,"currency":"EUR",
  //                      "reason":"Customer reports damage"},
  //                    "reason":"Customer requests a refund"}'
  //   safeJsonParse 过两道关卡：
  //     关卡 1  JSON.parse —— 语法是合法 JSON 吗？
  //     关卡 2  ActionProposalSchema —— 判别器读到 toolName 是
  //             refundOrder，直接路由到退款分支，逐格核对：
  //             orderId 像 ORD-001 吗？amount 是正数吗？多印格子了吗？
  //   全过 → 返回类型收窄后的 ActionProposal（amount 是 number，
  //          不是字符串 "79"——类型由 Schema 保证，不靠模型自觉）
  //   假如模型夹带 "requiresApproval": false → 关卡 2 的外层
  //   .strict() 当场抛 ZodError——单子连窗口都递不进去。
  return safeJsonParse<ActionProposal>(
    raw,
    "Action Proposal Agent",
    ActionProposalSchema
  );
  // 三步合一（见 utils.ts 里的实现）：
  //   1. JSON.parse(raw)          → 语法层校验
  //   2. ActionProposalSchema 校验 → 结构层校验
  //      （工具名在枚举内？参数形状对？有没有夹带权限字段？）
  //   3. 全过 → 返回类型化 ActionProposal；任一失败 → 抛带上下文的错误
  //
  // 因此本函数的返回值有一个很强的性质：
  //   只要它成功返回，结果一定是一个合法提案。
  //   调用方（index.ts / approvalService）不需要再怀疑数据质量。
  // 把校验收敛在"数据入口"，让下游代码活在干净世界里——
  // 这是所有 agent 系统都值得复制的结构。
}

// ============================================================
//  本文件小结：模型的职责边界
// ============================================================
//
// | 问题                     | 谁回答     | 在哪里回答        |
// |-------------------------|-----------|-------------------|
// | 用哪个工具、什么参数？     | 模型      | actionAgent.ts    |
// | 这个工具允许怎么执行？     | 代码查表  | policy.ts         |
// | 这次申请可以执行吗？       | 人类      | CLI approve/reject|
// | 真的执行过、结果是什么？   | executor  | executor.ts       |
//
// 三道防线防止模型越权：
//   1. prompt 明令禁止权限字段（引导）
//   2. Schema 双层 .strict() 拒绝未知字段（边界）
//   3. 提案类型里根本没有权限字段（结构上不可能表达）
//
// 下一站：policy.ts，看 toolName 如何被确定性映射到三种决策。
// ============================================================
