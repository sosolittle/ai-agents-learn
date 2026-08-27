// ============================================================
//  第三章：agent-loop（智能体循环）
//
//  🏠 生活化比喻（接着第二章的故事讲）：
//  第二章里，那位「百科全书式的新员工」拿到了内线电话，
//  但每次都是你问一句、他查一句、答一句——你是司机，他是导航。
//  这一章，你直接把一整项任务交给他：
//    「审查这个代码库的安全漏洞，写份报告给我。」
//  然后你就走开了。他自己决定先列文件、再逐个读、读完汇总，
//  最后交报告。对应到代码：
//    任务书        → user 消息里的 goal（目标，不是问题）
//    他的工作节奏  → while 循环（每圈 = 回办公桌想一步、干一步）
//    工作记录本    → messages 数组（每一步都追加，越写越厚）
//    下班时间      → MAX_ITERATIONS（安全带，防止他无限加班）
//    交报告的动作  → write_report 工具（terminal tool，显式宣布完成）
//
//  学习目标：
//  1. 区分“一问一答的工具调用”和“围绕目标持续行动的 agent”
//  2. 理解为什么 agent loop 必须有最大迭代次数
//  3. 学会用 terminal tool 让模型显式宣布任务完成
//  4. 观察模型如何自己决定先列文件、再读文件、最后写报告
//
//  核心结论：
//  Agent = 模型决策 + 工具执行 + 状态历史 + 停止条件。
//  没有停止条件的 agent，不是更智能，而是更容易失控。
//
//  本模块文件导航：
//  - index.ts（本文件）：npm start 运行的是它——安全审计 agent
//  - index_original.ts：最初的英文版，整体注释存档，供对照
// ============================================================

// Agent loop: the model pursues a goal over multiple steps, deciding what to do
// next each iteration. Unlike tool use (one query → one answer), the agent drives
// itself — you hand it a goal and it figures out how to reach it.

import "dotenv/config";
// 第三方包「副作用导入」：执行 dotenv/config，把 .env 装进 process.env。
import OpenAI from "openai";
// 本文件只在类型上用到它（OpenAI.Chat.* 命名空间里的类型）。
import client from "./src/openai-charles-client";
// 自己项目里的文件：带 Charles 抓包开关的客户端（见第一章的讲解）。

// const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
// ↑ 被注释的「直连版」写法，保留作对照。

const model = process.env.DEEPSEEK_FLASH_MODEL || "gpt-4o-mini";
// 模型名：.env 里配了 OPENAI_MODEL 就用配置的，否则默认 gpt-4o-mini。

// The most important constant in any agent.
// Without this, a confused model runs until you hit your rate limit.
const MAX_ITERATIONS = 15;
// 最大迭代次数是 agent 的安全带。
// 每次模型调用工具或继续思考，都会消耗 token 和时间。
// 模型一旦犯迷糊（比如反复读同一个文件、绕圈不出来），
// 没有这个上限，它会一直转到你撞上 API 速率限制、账单暴涨为止。
// 15 次 = 「这个任务正常 6 圈左右能完，留 2 倍余量」的经验值。

// ---------------------------------------------------------------------------
// 第一部分：模拟代码库——四个「文件」，三个埋了安全问题
// 真实 agent 里 read_file 会真的去读文件系统；这里用内存里的
// 字符串模拟。模型事先不知道每个文件的内容——必须逐个读过才知道，
// 和真实读盘一样。
//
// 埋的问题速览（读代码时可以自己先找一遍，再看 agent 找得全不全）：
//   src/auth.ts  → JWT 密钥硬编码（"hardcoded-secret-123"）
//   src/db.ts    → 数据库密码硬编码（admin123）+ SQL 注入（字符串拼接）
//   src/api.ts   → 上传文件名没校验（路径穿越风险）
//   src/utils.ts → 干净，没有问题（用来考验 agent 会不会「硬凑问题」）
// ---------------------------------------------------------------------------

// TS 语法：Record<string, string> = 键是文件路径、值是文件内容的字典。
//
// 值用反引号模板字符串书写：反引号里的内容可以跨行原样保留
// （普通引号字符串一换行就报错），非常适合存放「整段代码文本」。
// 末尾的 .trim() 把首尾的空行/缩进去掉，让内容更接近真实文件的样子。
//
// 📤 输入输出走查（这个字典怎么被用）：
//   FILES["src/auth.ts"]  → 一整段 auth.ts 的源代码字符串
//   FILES["nope.ts"]      → undefined → readFile 返回「未找到文件」
const FILES: Record<string, string> = {
    "src/auth.ts": `
import jwt from "jsonwebtoken";

export function createToken(userId: string) {
  // TODO: move secret to env var
  return jwt.sign({ userId }, "hardcoded-secret-123", { expiresIn: "7d" });
}

export function verifyToken(token: string) {
  return jwt.verify(token, "hardcoded-secret-123");
}
  `.trim(),

    "src/db.ts": `
import mysql from "mysql2";

export function getConnection() {
  return mysql.createConnection({
    host: "localhost",
    user: "root",
    password: "admin123",
    database: "app_db",
  });
}

export function queryUser(id: string) {
  const conn = getConnection();
  // user input concatenated directly into the query
  return conn.query("SELECT * FROM users WHERE id = " + id);
}
  `.trim(),

    "src/api.ts": `
import express from "express";
import { queryUser } from "./db";

const app = express();
app.use(express.json());

app.get("/user/:id", async (req, res) => {
  const user = await queryUser(req.params.id);
  res.json(user);
});

app.post("/upload", (req, res) => {
  const { filename } = req.body;
  // no validation on filename — path traversal risk
  const filePath = "/uploads/" + filename;
  res.json({ path: filePath });
});

export default app;
  `.trim(),

    "src/utils.ts": `
export function formatDate(date: Date): string {
  return date.toISOString().split("T")[0];
}

export function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

export function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max) + "..." : str;
}
  `.trim(),
};

// ---------------------------------------------------------------------------
// 第二部分：工具实现——列文件、读文件、外加一个「终止工具」
// 步骤顺序由 agent 自己决定，我们不写任何「先做 A 再做 B」的剧本。
// ---------------------------------------------------------------------------

function listFiles(): string {
    // 工具 1：列出可审查文件。agent 不应该凭空知道有哪些文件。
    // TS 语法：Object.keys(对象) 拿到所有键组成的数组；
    // JSON.stringify 再把数组变成文本（tool 消息的 content 要字符串）。
    // 📤 走查：返回 '["src/auth.ts","src/db.ts","src/api.ts","src/utils.ts"]'
    return JSON.stringify(Object.keys(FILES));
}

function readFile(path: string): string {
    // 工具 2：读取某个文件。只有读过文件，模型才能基于真实内容审查。
    // 路径必须和 list_files 返回的完全一致——拼错一点就是 undefined。
    const content = FILES[path];
    if (!content) return `未找到文件：${path}`;
    return content;
}

// Terminal tool（终止工具）——agent 一旦调用它，任务就算完成。
// 为什么不直接等 finish_reason === "stop"？因为「不再调工具」只是
// 「停下来」，不等于「郑重宣布做完」；让模型显式调用 write_report
// 来交报告，完成信号更明确、更可靠。
//
// TS 语法：let（而不是 const）+ 类型 string | null——这个变量
// 之后会被重新赋值，所以用 let；初始值 null 表示「报告还没交」。
// 它是模块级变量：writeReport 写入，下面的循环里读取判断。
let finalReport: string | null = null;

function writeReport(content: string): string {
    // 工具 3：终止工具。模型调用它表示“我已经完成任务，要输出最终报告”。
    finalReport = content;
    // 返回一句确认语——它也会作为 tool 结果回到模型那里，
    // 只是这一圈循环马上就要退出了，确认语主要给我们自己的日志看。
    return "报告已保存。";
}

// ---------------------------------------------------------------------------
// 第三部分：工具定义——给模型看的「工具菜单」（同第二章的讲法）
// name 是分机号，description 告诉模型什么时候用、怎么用。
// 注意 write_report 的 description 里明确写了「调用此工具将结束审计」
// ——把终止语义写进说明书，模型才知道交报告 = 收工。
//
// TS 语法：OpenAI.Chat.ChatCompletionTool[] = SDK 命名空间里的类型
// 组成的数组，直接借用保证形状和 create() 期待的一致。
// ---------------------------------------------------------------------------

const tools: OpenAI.Chat.ChatCompletionTool[] = [
    {
        type: "function",
        function: {
            name: "list_files",
            description: "列出所有可供审查的源代码文件",
            parameters: {type: "object", properties: {}, required: []},
        },
    },
    {
        type: "function",
        function: {
            name: "read_file",
            description: "读取指定源代码文件的完整内容",
            parameters: {
                type: "object",
                properties: {
                    path: {
                        type: "string",
                        description: "文件路径，必须与 list_files 返回的路径完全一致，例如 src/auth.ts",
                    },
                },
                required: ["path"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "write_report",
            // TS 语法：多个字符串用 + 拼接——纯粹为了排版（一行太长），
            // 拼出来的效果和写成一整行一模一样。
            description:
                "编写最终安全审计报告。审查完所有文件并汇总全部发现后调用此工具。" +
                "报告应按严重程度组织问题。调用此工具将结束审计。",
            parameters: {
                type: "object",
                properties: {
                    content: {
                        type: "string",
                        description: "使用 Markdown 格式编写的完整中文安全审计报告",
                    },
                },
                required: ["content"],
            },
        },
    },
];

// ---------------------------------------------------------------------------
// 第四部分：parseToolArgs —— 参数解析
// 和第二章完全一样：模型发来的 arguments 永远是 JSON 字符串
// （不是对象），必须先 JSON.parse；解析失败就返回空对象 {}，
// 让 executeTool 报「缺少必填参数」、模型下一圈自我纠正，
// 而不是让整个循环崩掉。
//
// TS 语法：catch { } 是「可选 catch 绑定」（不用错误变量时可以省掉）；
// as Record<…> 是类型断言（JSON.parse 返回 any，我们向编译器
// 承诺它的形状）。详见第二章 index2.ts 第三部分的展开讲解。
// ---------------------------------------------------------------------------

function parseToolArgs(raw: string): Record<string, string> {
    try {
        return JSON.parse(raw) as Record<string, string>;
    } catch {
        return {};
    }
}

// ---------------------------------------------------------------------------
// 第五部分：Dispatcher（分发器）——安全边界
// 所有工具请求都经过这里，便于集中做参数校验和权限控制。
// 模型只能递「申请单」，switch 里列出的函数才会真正执行；
// 真实项目里鉴权、限流也加在这一层。
//
// TS 语法：default 兜底不可省——模型可能幻觉出不存在的工具名。
// ---------------------------------------------------------------------------

function executeTool(name: string, args: Record<string, string>): string {
    // 所有工具请求都经过这里，便于集中做参数校验和权限控制。
    switch (name) {
        case "list_files":
            return listFiles();
        case "read_file":
            if (!args.path) return "缺少必填参数：path";
            return readFile(args.path);
        case "write_report":
            if (!args.content) return "缺少必填参数：content";
            return writeReport(args.content);
        default:
            // The model can hallucinate a tool name — always handle the unknown case.
            return `未知工具："${name}"`;
    }
}

// ---------------------------------------------------------------------------
// 第六部分：agent 循环——本章模式的核心
//
// 和工具调用（第二章）最关键的区别：谁在主导循环。
//   工具调用：  你问一个问题 → 模型调工具 → 模型回答（一问一答）
//   agent 循环：你给一个目标 → 模型自己决定下一步 → 重复直到完成
//
// 模型自己规划步骤：按它认为合理的顺序读文件、自己判断信息够不够、
// 够了就调 write_report 交报告。你从头到尾没有告诉它「先做什么
// 再做什么」——这正是 agent 的意义所在。
//
// 这个demo 防御的两种失控：
//   1. 死循环——模型犯迷糊，永远调工具停不下来（用 MAX_ITERATIONS 拦）
//   2. 上下文膨胀——每圈都在追加消息，跑太久 messages 会撑爆
//      （长任务要做「历史压缩/摘要」，本课先用迭代上限兜底）
//
// 本 demo 的迭代流程（大致如此，模型每次的细节可能不同）：
//   第 1 圈：→ list_files()                  ← 发现有 4 个文件
//   第 2 圈：→ read_file("src/auth.ts")       ← 发现硬编码密钥
//   第 3 圈：→ read_file("src/db.ts")         ← 发现 SQL 注入 + 弱口令
//   第 4 圈：→ read_file("src/api.ts")        ← 发现路径穿越风险
//   第 5 圈：→ read_file("src/utils.ts")      ← 干净文件，无问题
//   第 6 圈：→ write_report("# 安全审计…")    ← 任务完成，循环退出
// ---------------------------------------------------------------------------

// TS 语法：Promise<string> —— async 函数的返回类型，
// 「将来会产出一个 string 的凭证」，调用方用 await 接。
async function runAgent(goal: string): Promise<string> {
    // 和 02-tool-use 最大的区别：
    // 这里用户给的是一个目标，而不是一个具体问题。
    // 模型自己决定需要调用哪些工具、调用顺序是什么。
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
        {
            // system 提示词是「岗位说明书」：角色（安全审计员）+ 工作流程
            // （先列文件 → 逐个读 → 全读完才能交报告）+ 交付物格式
            // （中文、按严重程度分级）。
            // 注意它只规定了流程约束，没有规定具体先读哪个文件——
            // 那是模型自己权衡的事。约束「完成标准」、放开「执行顺序」，
            // 是写 agent 提示词的核心手感。
            // （多个字符串用 + 拼接只是为了排版，见第三部分的语法说明。）
            role: "system",
            content:
                "你是一名代码安全审计员。" +
                "首先列出所有文件，然后逐一仔细阅读。" +
                "只有审查完每个文件后，才能调用 write_report。" +
                "请使用中文撰写报告，并按严重程度组织发现：严重、高危、中危。",
        },
        {role: "user", content: goal},
    ];

    // let： iteration 会被 ++ 修改，所以不能用 const。
    let iteration = 0;

    console.log(`目标：${goal}\n`);

    // 无限循环：出口有两个（A=模型直接说话，B=交报告），
    // 外加一道保险丝（迭代上限）。
    while (true) {
        // TS 语法：iteration++ = 先用再加一的简洁写法（这里只用其副作用）。
        iteration++;

        // Circuit breaker — remove this and a confused model runs until rate-limited.
        // 保险丝：超过上限就抛错终止。抛错而不是悄悄 return，
        // 是为了让「任务没完成」这件事响亮地暴露出来。
        if (iteration > MAX_ITERATIONS) {
            throw new Error(
                `Agent exceeded ${MAX_ITERATIONS} iterations without completing the task. ` +
                `This usually means the model is stuck in a loop or the goal is too vague.`
            );
        }

        console.log(`[第 ${iteration} 次迭代]`);

        // 每圈一次真实模型调用：带上完整历史 + 工具菜单。
        const response = await client.chat.completions.create({
            model: model,
            messages,
            tools,
            tool_choice: "auto",
        });

        const choice = response.choices[0];
        // 模型这条回复必须进历史（tool 消息要紧跟发起调用的 assistant 消息）
        messages.push(choice.message); // always append — model needs its own history

        // 出口 A：模型不再调工具、直接说话了。
        // 本 demo 正常走不到这里（system 要求先 write_report），
        // 但作为兜底保留——万一模型「忘了」交报告直接聊天，
        // 也能把它的回答当作结果返回，不至于卡死。
        if (choice.finish_reason === "stop") {
            console.log();
            // ?? 空值合并：content 为 null 时兜成空串
            return choice.message.content ?? "";
        }

        if (choice.finish_reason === "tool_calls") {
            const toolCalls = choice.message.tool_calls ?? [];

            for (const call of toolCalls) {
                // arguments 是 JSON 字符串，先解析成对象（见第四部分）
                const args = parseToolArgs(call.function.arguments);
                const displayArgs = JSON.stringify(args);
                // 小细节：参数为空（"{}"）时日志里就不显示括号内容，
                // 让 list_files() 看起来更清爽——只影响打印，不影响逻辑。
                // TS 语法：条件表达式 条件 ? 真值 : 假值 的内联写法。
                console.log(`  → ${call.function.name}(${displayArgs === "{}" ? "" : displayArgs})`);

                const result = executeTool(call.function.name, args);

                // 出口 B：终止工具被调用了——agent 宣布完成。
                if (call.function.name === "write_report" && finalReport !== null) {
                    // write_report 已经把 finalReport 设置好，说明任务显式完成。
                    // 这比“模型不再调用工具”更可靠。
                    console.log(`  ← 报告已写入（${finalReport.length} 个字符）\n`);
                    // Push the result so message history stays valid, then exit cleanly.
                    // 先把 tool 结果补进历史再 return：
                    // 每个工具申请都必须有一条配对的 tool 消息，否则历史就是
                    // 非法的。虽然马上要退出了，也别留下破损的 messages。
                    messages.push({role: "tool", tool_call_id: call.id, content: result});
                    return finalReport;
                }

                // Truncate long results in the log — full content still goes into messages.
                // 日志里只显示前 80 个字符（文件内容太长会刷屏），
                // 但塞进 messages 的是完整 result——模型看到的不能缩水。
                // TS 语法：三元 + slice(0, 80)（取前 80 个字符）+ 字符串拼接。
                const preview = result.length > 80 ? result.slice(0, 80) + "…" : result;
                console.log(`  ← ${preview}`);

                messages.push({role: "tool", tool_call_id: call.id, content: result});
            }

            console.log();
            // 干完这圈的活，回到 while 顶部：带着新历史让模型想下一步
        }
    }
}

// ---------------------------------------------------------------------------
// 第七部分：Demo——把整个代码库交给 agent 审计
// ---------------------------------------------------------------------------

async function main() {
    // 注意 user 消息是「目标」而不是「问题」：没有问哪个文件、
    // 没有规定顺序，只说了两件事——查漏洞 + 全部看完再写报告。
    //
    // 📤 输入输出走查（控制台预期输出，大意）：
    //   目标：审查此代码库中存在的安全漏洞。请在撰写报告前审查每一个文件。
    //
    //   [第 1 次迭代]
    //     → list_files()
    //     ← ["src/auth.ts","src/db.ts","src/api.ts","src/utils.ts"]
    //        ↑ 模型先「摸清家底」——它事先并不知道有哪些文件
    //
    //   [第 2 次迭代]
    //     → read_file({"path":"src/auth.ts"})
    //     ← import jwt from "jsonwebtoken";…（日志只显示前 80 字符，
    //        完整内容已进 messages）模型从中发现硬编码密钥
    //
    //   [第 3 次迭代]
    //     → read_file({"path":"src/db.ts"})
    //     ← …发现 admin123 弱口令 + SQL 字符串拼接注入
    //
    //   [第 4 次迭代]
    //     → read_file({"path":"src/api.ts"})
    //     ← …发现上传文件名未校验（路径穿越风险）
    //
    //   [第 5 次迭代]
    //     → read_file({"path":"src/utils.ts"})
    //     ← …干净的纯工具函数，没有问题
    //
    //   [第 6 次迭代]
    //     → write_report({"content":"# 安全审计报告\n…"})
    //     ← 报告已写入（约 1000+ 个字符）
    //
    //   ─────────────────────────────
    //   最终报告：
    //   # 安全审计报告
    //   ## 严重
    //   - src/auth.ts：JWT 密钥硬编码（hardcoded-secret-123）…
    //   - src/db.ts：SQL 注入（用户输入直接拼接进查询）…
    //   ## 高危
    //   - src/db.ts：数据库弱口令 admin123…
    //   - src/api.ts：上传文件名未校验，存在路径穿越…
    //   ## 中危 / 无问题
    //   - src/utils.ts：未发现问题…
    //
    // 两个值得体会的点：
    // 1. 顺序是模型自己定的（受 system 提示词「先列清单再逐个读」约束，
    //    但每个文件何时读、何时收工都是它自己判断的）；
    // 2. 每次运行细节会有差异（比如先读哪个文件、报告的措辞和分级），
    //    这正是 agent 的特点——确定的是流程和不变量，不确定的是路径。
    //    所以后面的模块会专门讲怎么给 agent 加「护栏」和「验收」。
    const report = await runAgent(
        "审查此代码库中存在的安全漏洞。" +
        "请在撰写报告前审查每一个文件。"
    );

    console.log("─".repeat(60));
    console.log("\n最终报告：\n");
    console.log(report);
}

// 顶层兜底：任何一圈抛出的错误（含保险丝熔断的「超过最大迭代」）
// 都会被接住打到控制台。
main().catch(console.error);
