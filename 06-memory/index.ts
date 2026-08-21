// ============================================================
//  第六章：memory（记忆）
//
//  🏠 生活化比喻（接着前五章的故事讲）：
//  那位新员工现在已经会调工具、跑循环、搜网页、抓原文了。
//  但有个尴尬的事：他每次「请示总部」（调用模型 API）之前，
//  都要把这段对话的便利贴全部念一遍——因为总部每次都是
//  「空降临时工」，什么都不记得，全靠现场念给他听。
//
//    便利贴堆      → messages 数组（对话历史）
//    办公桌大小    → 上下文窗口（有限，而且每念一遍都按字收费）
//    念便利贴      → 每次 API 请求都携带完整 history
//  聊到第 100 轮，桌上的便利贴几千张：又贵又慢，迟早撑爆。
//
//  本章实现四种「整理办公桌」的策略：
//    1. full-buffer     全保留：一张不扔。信息最全，桌子迟早堆满。
//    2. sliding-window  滑动窗口：只留最近 N 张，旧的直接扔。
//    3. summary         摘要：定期把旧便利贴压缩成一页「会谈纪要」。
//    4. persistent      持久：把稳定事实（姓名/偏好）抄进笔记本存盘，
//                        下次上班先翻笔记本——跨天、跨重启还记得。
//
//  学习目标：
//  1. 理解“记忆”本质上是应用层状态管理，不是模型自动拥有的能力
//  2. 对比 full-buffer、sliding-window、summary、persistent 四种策略
//  3. 看懂为什么上下文窗口既有限又昂贵
//  4. 学会把“短期对话历史”和“长期事实记忆”分开思考
//
//  核心结论：
//  记忆不是越多越好，而是要决定保留什么、压缩什么、丢弃什么。
//  最危险的是 sliding-window 式的「无声失忆」——不报错，只是不再知道。
// ============================================================

// Memory is a state management problem.
//
// The token context window is your RAM — finite and expensive. Every request
// pays for everything in the window. After enough turns, you hit the limit.
// These four strategies show the same tradeoff you face in any stateful system:
// what do you keep, what do you compress, and what do you evict?
// （上下文窗口就是内存：有限、昂贵、每次请求都要为窗口里的一切付费。
//   任何有状态系统都逃不开这三问：留什么、压什么、扔什么。）
//
// Run with:
//   npm start              → full-buffer (the naive default)
//   npm start window       → sliding-window (evicts old turns like LRU cache)
//   npm start summary      → summary (compresses old turns into a digest)
//   npm start persist      → persistent (saves facts across sessions to disk)
// （命令行参数选策略；四种跑法的对比见文件末尾 Demo 的走查。）

import "dotenv/config";
import OpenAI from "openai";
// fs / path：Node 内置的文件系统与路径模块。持久策略要读写 memory.json。
import * as fs from "fs";
import * as path from "path";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// TS 语法：type 起别名——给冗长的类型起个短名字。
// 之后所有地方写 Message 就等于写那一长串 SDK 类型。
type Message = OpenAI.Chat.ChatCompletionMessageParam;

// ---------------------------------------------------------------------------
// 第一部分：Memory 接口——四种策略共用的「统一插座」
//
// 接口只规定「你必须会什么」（label + add + getMessages），
// 不规定「你怎么做到」。于是 chat() 只认插座、不认实现：
// 换任何记忆策略，chat() 一行都不用改——这就是第六章要传的
// 「依赖抽象，不依赖具体」的手感。
// ---------------------------------------------------------------------------

interface Memory {
  // Memory 是四种策略共同遵守的接口。
  // 只要实现 add 和 getMessages，chat() 就不用关心具体记忆策略。
  label: string; // 策略名，仅用于 demo 打印
  // TS 语法：接口里可以描述方法。这两种写法分别读作
  // 「add 是一个函数：接收 role 和 content，返回 Promise<void>」。
  // role 的类型 "user" | "assistant" 是「字面量联合」——只允许这两个词。
  add(role: "user" | "assistant", content: string): Promise<void>;
  getMessages(): Message[];
}

// ---------------------------------------------------------------------------
// 第二部分：策略 1 full-buffer——全保留（最朴素的默认）
//
// Keep every message. Zero extra complexity. Works perfectly in demos.
//
// The failure mode: context window grows linearly. Each API call pays for the
// entire conversation history. At 100 turns of a typical chat, you're pushing
// 10k–30k tokens into every request — before the model even starts responding.
// At some point you hit the model's context limit and the API throws an error.
// （失败方式很直白：线性增长 → 越来越贵越来越慢 → 撞上上下文上限报错。
//   至少它是「响亮地失败」，你能立刻知道。）
// ---------------------------------------------------------------------------

// TS 语法：class X implements Y = 「X 承诺实现 Y 接口的全部成员」。
// 少实现任何一个，编译器立刻报错——接口由此成为「契约」。
class FullBufferMemory implements Memory {
  // 最朴素的记忆：所有消息原样保存。
  // 优点是信息完整；缺点是成本和上下文长度线性增长。
  label = "full-buffer";
  // TS 语法：private = 只有本类内部能访问（外部 memory.history 会报错）。
  // = [] 是字段初始化：每个新实例都从空数组开始。
  private history: Message[] = [];

  async add(role: "user" | "assistant", content: string): Promise<void> {
    this.history.push({ role, content });
  }

  getMessages(): Message[] {
    // 原样返回全部——什么都不做，正是这个策略的全部内容。
    return this.history;
  }
}

// ---------------------------------------------------------------------------
// 第三部分：策略 2 sliding-window——滑动窗口
//
// Keep only the last N messages. Context window stays bounded. Cheap and simple.
//
// The silent bug: the model forgets anything before the window. If the user
// said their name at turn 1 and you're at turn 20, it's gone — permanently.
// Same as LRU cache eviction. You never see the error; the model just stops
// knowing things it once knew.
//
// Real-world shape: good for short, stateless exchanges (commands, one-shot
// questions). Bad for long conversations where early context matters.
// （适合一次性的短交互；对「早期信息很重要」的长对话是灾难。
//   它是本章 Demo 里唯一会答错问题的策略——故意的，那就是考点。）
// ---------------------------------------------------------------------------

class SlidingWindowMemory implements Memory {
  // 滑动窗口：只保留最近 N 条消息。
  // 它适合短任务，但会忘记早期事实。
  label = "sliding-window";
  private history: Message[] = [];

  // TS 语法：构造函数「参数属性」——参数前加 private readonly，
  // TS 会自动帮你声明字段并赋值，一行顶三行。等价于：
  //   private readonly windowSize: number;
  //   constructor(windowSize: number) { this.windowSize = windowSize; }
  // = 6 是默认值：new SlidingWindowMemory() 不传参时用 6。
  constructor(private readonly windowSize: number = 6) {}

  async add(role: "user" | "assistant", content: string): Promise<void> {
    // 注意：add 时照单全收，淘汰发生在 getMessages 里。
    // 这样「存」和「取」的职责分得很清楚。
    this.history.push({ role, content });
  }

  getMessages(): Message[] {
    // Keep an even number to preserve complete user/assistant pairs
    // 取整为偶数：保证窗口边界落在完整的「一问一答」上。
    // 若窗口是奇数（比如 7），Math.floor(7/2)*2 = 6，宁可少留一条，
    // 也不让窗口从某个回答的中间开始——残缺的问答对会干扰模型。
    // TS 语法：Math.floor(6 / 2) = 3，3 * 2 = 6（对偶数是原样，奇数则减一）。
    const keep = Math.floor(this.windowSize / 2) * 2;
    // TS 语法：slice(-keep) 的负数索引 = 「从结尾往前数 keep 条」。
    // slice(-6) 取最后 6 条；history 不足 6 条时全取（不报错）。
    return this.history.slice(-keep);
  }
}

// ---------------------------------------------------------------------------
// 第四部分：策略 3 summary——摘要压缩
//
// When the history grows past a threshold, summarize the old turns into a
// single compressed "memory" message and discard them. Context stays bounded
// while meaning is preserved.
//
// The tradeoff: summaries lose resolution. You get "user prefers TypeScript"
// not the exact argument they made for it. For most conversational use cases,
// that's fine — you need the gist, not the transcript.
// （取舍：细节换长度。拿到的是「要点」，不是「原话」。）
//
// Key design detail: we always compress after the assistant turn, never mid-turn.
// That way getMessages() is always in a clean, ready state when the next
// request is built.
// （关键设计：只在 assistant 回复后才压缩，绝不在半轮之间动手——
//   保证下一次拼请求时，历史永远处于「干净、可用」的状态。）
// ---------------------------------------------------------------------------

class SummaryMemory implements Memory {
  // 摘要记忆：把旧消息压缩成 summary，再保留最近对话。
  // 它牺牲细节，换取更稳定的上下文长度。
  label = "summary";
  private history: Message[] = [];
  // 摘要内容。null 表示「还没压缩过」——第一段对话总是原样保留的。
  private summary: string | null = null;

  // 超过多少条消息后触发压缩（默认 6）。
  constructor(private readonly summarizeAfter: number = 6) {}

  async add(role: "user" | "assistant", content: string): Promise<void> {
    this.history.push({ role, content });

    // 只在 assistant 回复后检查：此时一问一答成对完整，
    // 压缩不会切断正在进行的轮次（见上面的设计说明）。
    if (role === "assistant" && this.history.length > this.summarizeAfter) {
      await this.compress();
    }
  }

  private async compress(): Promise<void> {
    // compress 会调用模型来总结旧对话。
    // 注意：总结本身也是一次模型调用，也有成本和出错概率。
    //
    // TS 语法：两个 slice 配合把数组切成「旧的」和「新的」：
    //   slice(0, -2) = 从头到「倒数第 2 条之前」→ 要压缩的旧消息
    //   slice(-2)    = 最后 2 条（最近的一问一答）→ 原样保留
    // 📤 走查（history 有 8 条时触发压缩）：
    //   toCompress = 第 1~6 条 → 送去总结后丢弃
    //   history    = 第 7~8 条 → 继续留在桌上
    const toCompress = this.history.slice(0, -2); // keep the last exchange fresh
    this.history = this.history.slice(-2);

    // 已有旧摘要时，让模型「在旧摘要基础上增量总结」，而不是从头再总结，
    // 否则每压缩一次，最早的事实就可能掉一次。
    const prior = this.summary
      ? `Prior summary:\n${this.summary}\n\n`
      : "";

    // 把待压缩的消息拼成 "role: content" 的纯文本清单。
    const turns = toCompress
      .map((m) => `${m.role}: ${m.content}`)
      .join("\n");

    // 一次独立的模型调用：专职总结，不带工具、不带循环。
    // 提示词要求「只留未来轮次需要保持一致的事实」——姓名、偏好、决定，
    // 并明确「跳过寒暄」：摘要的目标是信息密度。
    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content:
            `${prior}Summarize the key facts from this conversation in 3-5 bullet points. ` +
            `Focus on what the assistant would need to stay consistent in future turns: ` +
            `user goals, preferences, names, and any decisions made. ` +
            `Be specific. Skip filler and pleasantries.\n\n${turns}`,
        },
      ],
    });

    this.summary = response.choices[0].message.content ?? "";
    console.log(`  [summary] Compressed ${toCompress.length} messages → ${this.summary.length} chars`);
  }

  getMessages(): Message[] {
    const messages: Message[] = [];
    if (this.summary) {
      // 摘要作为一条 system 消息放在最前面——「会谈纪要」置顶，
      // 模型先读纪要、再读最近几轮原文。
      messages.push({
        role: "system",
        content: `Summary of earlier conversation:\n${this.summary}`,
      });
    }
    // TS 语法：... 展开运算符——把数组里的元素逐个放进新数组。
    // [...messages, ...this.history] = 「纪要（可能有）+ 最近对话」拼成一条完整历史。
    // 这样返回的是新数组，外部改动不会污染内部状态。
    return [...messages, ...this.history];
  }
}

// ---------------------------------------------------------------------------
// 第五部分：策略 4 persistent——持久记忆（跨会话）
//
// After each assistant reply, extract key facts and write them to disk.
// Inject them at session start. The agent remembers you next time — across
// restarts, across days.
//
// This is the same pattern as a user profile store in a web app: you don't
// replay the entire request history, you persist the signal and discard the noise.
// （类比网页应用的「用户画像存储」：不重放全部历史，只留存信号、丢弃噪音。）
//
// Run `npm start persist` twice with the same question to see it kick in.
// The second run will already know what the first run learned.
//
// memory.json is written to the current working directory and gitignored.
// （连跑两次 persist：第二次启动时会打印「从上次会话加载了 N 条事实」。）
// ---------------------------------------------------------------------------

// memory.json is written to the directory where you run npm start.
// TS 语法：path.join(目录, 文件名) 拼出跨平台路径；
// process.cwd() = 当前运行目录（在哪执行 npm start，文件就落在哪）。
const MEMORY_FILE = path.join(process.cwd(), "memory.json");

class PersistentMemory implements Memory {
  // 持久记忆：把稳定事实保存到磁盘，下次运行还能加载。
  // 这模拟了真实产品里的用户画像/偏好存储。
  label = "persistent";
  private history: Message[] = [];
  // 长期记忆：从磁盘加载的事实列表（会话内还会继续追加）。
  private facts: string[] = [];

  constructor() {
    // 启动即尝试加载上次留下的事实。文件不存在/内容损坏
    // 都当作「第一次上班」处理（facts = []），而不是崩溃。
    try {
      const raw = fs.readFileSync(MEMORY_FILE, "utf-8");
      this.facts = JSON.parse(raw) as string[];
    } catch {
      this.facts = [];
    }

    if (this.facts.length > 0) {
      console.log(`  [memory] Loaded ${this.facts.length} fact(s) from last session:`);
      this.facts.forEach((f) => console.log(`    - ${f}`));
    }
  }

  async add(role: "user" | "assistant", content: string): Promise<void> {
    this.history.push({ role, content });
    if (role === "assistant") {
      // 每次 assistant 回复后，都从最近几轮里抽一次事实。
      // 放在 assistant 之后：一轮完整对话到齐了才下手。
      await this.extractAndSave();
    }
  }

  private async extractAndSave(): Promise<void> {
    // 从最近几轮中抽取“用户明确说过的稳定事实”。
    // 不保存模型猜测，也不保存临时闲聊，这能减少错误记忆污染。
    // 只看最近 4 条（两问两答）：更早的事实上次已经抽过了，重复抽没意义。
    const recentTurns = this.history
      .slice(-4)
      .map((m) => `${m.role}: ${m.content}`)
      .join("\n");

    // 抽取也是一次模型调用。response_format 的 json_object 让输出
    // 保证是合法 JSON（第一章 6.structured-output 讲过），便于程序解析。
    // 提示词里的三条「不要」很关键：不推断、不存模型建议、不存纯话题——
    // 记忆污染比记忆缺失更难排查。
    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content:
            `From this exchange, extract only facts explicitly stated by the user: ` +
            `their name, clearly stated preferences, stable goals, or decisions they made. ` +
            `Do not infer preferences from assistant suggestions. ` +
            `Do not save facts about topics merely discussed unless the user stated a goal, preference, name, or decision. ` +
            `Return JSON in exactly this format: {"facts": ["...", "..."]}. ` +
            `Return {"facts": []} if nothing is worth saving.\n\n${recentTurns}`,
        },
      ],
      response_format: { type: "json_object" },
    });

    try {
      // 解析模型返回的 JSON。content 为 null 时兜底 "{}"（解析成空对象）。
      // as { facts?: string[] }：断言形状；facts? 表示字段可能缺失。
      const parsed = JSON.parse(
        response.choices[0].message.content ?? "{}"
      ) as { facts?: string[] };

      // 清洗：每条去首尾空白，去掉空串。
      const newFacts = (parsed.facts ?? [])
        .map((f: string) => f.trim())
        .filter((f: string) => f.length > 0);

      if (newFacts.length > 0) {
        // Deduplicate and keep a rolling cap so the file never grows unbounded
        // 合并去重 + 滚动上限：
        //   [...this.facts, ...newFacts] 旧事实在前、新事实在后拼成数组
        //   new Set(...)                  自动去重（完全相同的句子只留一个）
        //   Array.from(...)               Set 转回数组（Set 没有 slice）
        //   .slice(-20)                   只留最近 20 条——文件永不无限增长
        this.facts = Array.from(new Set([...this.facts, ...newFacts])).slice(-20);
        // 写盘：JSON.stringify(数组, null, 2) 的后两个参数 = 缩进 2 空格，
        // 写出来的文件人类可读，方便你打开 memory.json 亲自看看它记了什么。
        fs.writeFileSync(MEMORY_FILE, JSON.stringify(this.facts, null, 2));
        console.log(`  [memory] Saved ${newFacts.length} new fact(s)`);
      }
    } catch {
      // Non-fatal — skip saving for this turn rather than crashing
      // 解析失败就跳过这一轮的保存，不让整场对话崩掉——
      // 记住少一条事实，远好于整个 agent 挂掉。
    }
  }

  getMessages(): Message[] {
    const messages: Message[] = [];
    if (this.facts.length > 0) {
      // 长期事实以 system 消息注入在最前（「我记得关于你的这些事」），
      // 模型带着这些背景进入本轮对话——就像接待熟客前先翻一眼客户卡。
      messages.push({
        role: "system",
        content: `What I remember about you from past conversations:\n${this.facts.map((f) => `- ${f}`).join("\n")}`,
      });
    }
    return [...messages, ...this.history];
  }
}

// ---------------------------------------------------------------------------
// 第六部分：chat()——只认「插座」的对话函数
// ---------------------------------------------------------------------------

async function chat(memory: Memory, userMessage: string): Promise<string> {
  // chat 不关心具体是哪种记忆实现。
  // 这就是接口的价值：调用方只依赖统一能力，而不是依赖某个类的细节。
  // 参数类型是 Memory（接口），所以四种实现都能传进来。
  await memory.add("user", userMessage);

  // 注意 messages 的拼法：固定的 system 提示词在前，
  // 然后展开 memory.getMessages()——摘要/事实（如果有）+ 最近对话。
  // 「记忆」就这样无声地进入了每一次请求。
  //
  // system 里那句「只根据你在对话历史里真实能看到的内容回答」
  // 是为 Demo 服务的：让 sliding-window 的失忆表现为「诚实地答不上来」，
  // 而不是当场编一个名字——把失败暴露得干净利落。
  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content:
          "You are a helpful assistant. Keep replies to 2-3 sentences. " +
          "If asked about something from earlier in the conversation, " +
          "answer based only on what you can actually see in the conversation history.",
      },
      ...memory.getMessages(),
    ],
  });

  const reply = response.choices[0].message.content ?? "";
  // 回复也要入记忆——下一轮它就是「历史」的一部分。
  await memory.add("assistant", reply);
  return reply;
}

// ---------------------------------------------------------------------------
// 第七部分：Demo——同一串对话，四种记忆，两种结局
//
// 10 turns on a single topic. Turn 1 plants a key fact (name + project).
// Turn 10 asks for it directly. Each strategy handles that question differently:
//
//   full-buffer   → answers correctly (nothing is ever evicted)
//   sliding-window→ fails (turn 1 is outside the 6-message window)
//   summary       → answers correctly (the fact survived compression)
//   persistent    → answers correctly (the fact was saved to disk)
//
// The turn 10 failure of sliding-window is the insight. In demos, agents look
// great. In production, that turn-1 context is gone by turn 20.
// （考点就在第 10 问：第 1 轮埋下的「名字 + 项目」，谁还记得？
//   demo 里 agent 个个能干；生产环境里，第 1 轮的信息到第 20 轮就没了。）
// ---------------------------------------------------------------------------

const CONVERSATION: string[] = [
  // 转折设计：第 1 轮埋事实（Alex + React 实时仪表盘 + WebSockets），
  // 第 2~9 轮用一连串相关技术问题把历史撑长（每轮都是真实追问，
  // 不是凑数的废话），第 10 轮突然回头问第 1 轮的事。
  "Hi! My name is Alex. I'm building a real-time dashboard in React with WebSockets.",
  "What are some good libraries for WebSocket state management in React?",
  "Tell me about the tradeoffs between SWR and React Query for this use case.",
  "Which one handles server-sent events better?",
  "What's the actual difference between SSE and WebSockets at the protocol level?",
  "When would polling be a better choice than WebSockets?",
  "And long polling — how is that different from regular polling?",
  "How does any of this relate to the CAP theorem?",
  "How do distributed systems handle network partitions in practice?",
  "One last thing — what was my name, and what project was I building?",
];

async function runDemo(memory: Memory): Promise<void> {
  // 用同一段 10 轮对话测试不同记忆策略。
  // 第 10 轮会问第 1 轮的信息，用来暴露“忘记早期上下文”的问题。
  console.log(`\n${"═".repeat(60)}`);
  console.log(`Strategy: ${memory.label.toUpperCase()}`);
  console.log("═".repeat(60));

  for (let i = 0; i < CONVERSATION.length; i++) {
    const userMsg = CONVERSATION[i];
    const reply = await chat(memory, userMsg);

    console.log(`\n[turn ${i + 1}]`);
    console.log(`User:      ${userMsg}`);
    console.log(`Assistant: ${reply}`);
  }
}

// ---------------------------------------------------------------------------
// 第八部分：入口——用命令行参数选策略
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const strategy = process.argv[2] ?? "full";
  // process.argv[2] 是命令行参数：
  // npm start window / summary / persist 会选择不同记忆实现。
  // ?? "full"：不带参数时默认 full-buffer。
  //（argv[0] 是 node 路径，argv[1] 是脚本路径，所以用户参数从 [2] 开始。）

  // TS 语法：嵌套三元表达式——条件 ? 值 : (条件 ? 值 : …)，
  // 从上往下读就是一串 if / else if / else，只是写成了表达式：
  //   window  → SlidingWindowMemory(6)
  //   summary → SummaryMemory(6)
  //   persist → PersistentMemory()
  //   其他    → FullBufferMemory()
  // 变量类型统一标为 Memory（接口）——四种实现在这里「汇流」。
  const memory: Memory =
    strategy === "window"
      ? new SlidingWindowMemory(6)
      : strategy === "summary"
      ? new SummaryMemory(6)
      : strategy === "persist"
      ? new PersistentMemory()
      : new FullBufferMemory();

  await runDemo(memory);
}

// 顶层兜底：任何一轮抛错都接住打到控制台。
main().catch(console.error);

// ============================================================
//  📤 附：四种策略的预期跑法（控制台大意）
//
//  ① npm start（full-buffer）
//    Strategy: FULL-BUFFER
//    [turn 1] User: Hi! My name is Alex. …
//    …（全部 10 轮原样保留）…
//    [turn 10] User: One last thing — what was my name, …
//    Assistant: You're Alex, and you're building a real-time
//    dashboard in React with WebSockets.
//    ✅ 答对：什么都留着，当然记得。
//
//  ② npm start window（sliding-window，本模块的「考点」）
//    第 10 轮提问时，历史已有 19 条消息；窗口只取最后 6 条
//    （第 7 轮的回答到第 10 轮的提问），第 1 轮的自我介绍早被扔掉：
//    [turn 10] Assistant: I don't actually see your name in the
//    conversation history I have access to — could you remind me?
//    ❌ 答不上——但注意它「诚实地失忆」而不是编造（system 提示词
//    功劳）。没有任何报错、没有任何日志提示出问题了：
//    这就是「无声失忆」，生产环境里最难排查的那种 bug。
//
//  ③ npm start summary（summary）
//    第 4 轮回复后历史达 8 条 > 6，触发压缩：
//      [summary] Compressed 6 messages → 2xx chars
//    第 1 轮的「Alex + React 仪表盘」作为要点活进了摘要；
//    第 10 轮照常答对 ✅——细节丢了，要点还在。
//
//  ④ npm start persist（persistent，连跑两次看效果）
//    第一次：每轮回复后抽取事实并存盘——
//      [memory] Saved 2 new fact(s)
//    第 10 轮答对 ✅（本次会话内历史本来就全）。
//    第二次（再跑一遍）：
//      [memory] Loaded 2 fact(s) from last session:
//        - User's name is Alex
//        - User is building a real-time dashboard in React …
//    会话还没开始，它已经「认识」你了——这才是跨会话的记忆。
// ============================================================
