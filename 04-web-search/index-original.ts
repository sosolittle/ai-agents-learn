// ============================================================
//  第四章：web-search（联网搜索 agent）
//
//  🏠 生活化比喻（接着前三章的故事讲）：
//  那位「百科全书式的新员工」已经很能干了：会打电话查订单
//  （第二章·工具调用），也能独立完成整项任务（第三章·agent 循环）。
//  但他肚子里的百科全书是「培训那年印刷」的——知识有截止日期。
//  你问「Node.js 22 有什么新特性」，他那本书里压根没这一页；
//  更麻烦的是，他可能不承认不知道，硬编一段像模像样的答案（幻觉）。
//
//  这一章给他配一条外线：打给图书馆咨询台（Tavily 搜索 API）。
//    打电话报关键词      → web_search(query)
//    咨询台念的每条摘要  → 搜索结果文本（标题 + URL + 摘录）
//    记进工作记录本      → tool 消息塞回 messages
//    资料够了就交卷      → write_answer（terminal tool，同第三章）
//  同时立一条铁律：答案只能引用电话里真听到的地址（URL），
//  不许凭空编造出处——就像记者只能引用真正采访过的人。
//
//  学习目标：
//  1. 理解 web_search 只是一个普通工具——循环骨架和 03 一模一样
//  2. 看懂用 fetch 发起真实 HTTP 请求的完整流程（本系列第一次联网！）
//  3. 学会把 API 返回的 JSON「排版」成模型易读的纯文本
//  4. 理解防「编造引用」要靠提示词 + 结果格式双管齐下
//
//  核心结论：
//  模型的知识有「印刷日期」（训练截止时间），搜索工具负责补上当下；
//  但搜索只提供原料——引用规范、何时停搜，仍要靠循环和提示词约束。
// ============================================================

// Web search agent: the model searches the web to answer a research question.
// The key insight: web_search is just another tool — a function that returns a
// string. The model decides when to call it and how many times. You never
// script the sequence. Same loop as 03-agent-loop, different tools.
// （一句话总结：同款循环、换了工具——搜什么、搜几次、何时收工，全由模型现场决定。）

import "dotenv/config";
// 副作用导入：把 .env 里的 OPENAI_API_KEY / TAVILY_API_KEY 装进 process.env。
import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
// Tavily 是外部搜索服务，所以除了 OPENAI_API_KEY，还需要 TAVILY_API_KEY。
// （05 章用同一家搜索服务，再加一个「抓网页」的工具。）

const MAX_ITERATIONS = 10;
// 迭代上限 = agent 的安全带（为什么必须有，见第三章的展开）。
// 研究任务通常 2~4 圈搜索 + 1 圈写答案，10 圈已是宽裕余量；
// 真的超了，多半是模型「搜索成瘾」停不下来，或问题太宽泛。

// ---------------------------------------------------------------------------
// 第一部分：Tavily 搜索——全文件唯一的真实网络 I/O
//
// Tavily 是专为 LLM agent 打造的搜索 API：它不返回原始 HTML，
// 而是返回「洗干净的文本摘录」，模型拿到就能直接读，无需解析网页。
//
// 每条结果的形状（interface 就是这个形状的说明书）：
//   { title, url, content }   ← content 是相关段落的摘录，不是整个页面
//
// 只要 5 条。结果越多 → 上下文越大 → 越慢越贵；
// 不够就再搜一次——这正是循环存在的意义。
// ---------------------------------------------------------------------------

// TS 语法：interface 描述「数据的形状」。下面两个接口分别描述
// 「单条搜索结果」和「整个响应的外壳」，让 response.json() 有型可断言。
interface TavilyResult {
  title: string;
  url: string;
  content: string;
}

interface TavilyResponse {
  results: TavilyResult[];
}

async function webSearch(query: string): Promise<string> {
  // webSearch 是真正联网的工具函数。
  // 模型只会提出 query；HTTP 请求、错误处理和结果裁剪由代码完成。
  // 返回值是 string 而非结构化数据——tool 消息的 content 只收文本，
  // 所以「排版」也在这一层做完（见函数末尾的 map/join）。
  //
  // TS 语法：fetch = 发 HTTP 请求的全局函数（浏览器同款，Node 18+ 内置，
  // 不用装任何包）。网络请求需要时间，fetch 立刻返回一个 Promise
  // （「取餐凭据」），await 负责原地等结果送到——这就是 async/await 的分工。
  const response = await fetch("https://api.tavily.com/search", {
    // 请求配置是一个「对象字面量」（键: 值，逗号分隔）：
    method: "POST", // POST = 参数放「请求体」里（查询内容塞 URL 会太长）
    headers: { "Content-Type": "application/json" }, // 告诉服务器：请求体是 JSON
    body: JSON.stringify({
      // body 只接受字符串——所以用 JSON.stringify 把这个对象
      // 「序列化」成一段 JSON 文本再发出去。
      api_key: TAVILY_API_KEY,
      query, // TS 语法：简写属性——只有变量名时，query 等价于 query: query
      max_results: 5,
      // search_depth: "basic" is faster; "advanced" re-ranks results but costs more quota
      search_depth: "basic",
    }),
  });

  if (!response.ok) {
    // 出口 1：HTTP 层面就失败了（比如 key 无效 → 401）。
    // 注意是「返回错误文本」而不是抛错——错误信息也会作为 tool 结果
    // 回到模型那里，它下一圈能换关键词重试，而不是整个循环崩掉。
    // response.ok = 状态码在 200~299；.status/.statusText 如 401 / "Unauthorized"。
    return `Search failed: ${response.status} ${response.statusText}`;
  }

  const data = (await response.json()) as TavilyResponse;
  // response.json()：把响应体（一段 JSON 文本）解析回 JS 对象——
  // 网络上来回传的都是文本，这一步同样要 await。
  // TS 语法：as TavilyResponse 是类型断言——json() 的返回类型是 any，
  // 我们向编译器「承诺」它长这个形状（运行时真不符 TS 不管，断言要慎用）。

  if (!data.results?.length) {
    // 出口 2：请求成功，但一条结果都没有（关键词太偏？）。
    // TS 语法：?. 可选链——results 为 null/undefined 时直接短路成
    // undefined，而不是抛 "Cannot read properties of undefined"。
    return "No results found for that query.";
  }

  // Format results as plain text — the model reads this, not JSON.
  // Each result gets a separator so the model can tell where one ends.
  // 出口 3（正常路径）：把结构化结果排版成纯文本——模型读的是这段文本，不是 JSON。
  //
  // TS 语法：数组方法三连——
  //   .map((r, i) => …)  把每个元素变成新样子（r = 当前元素，i = 序号）
  //   模板字符串里的 \n  是「换行」转义
  //   .join(分隔符)      把数组重新粘成一个长字符串
  //
  // 📤 输入输出走查（2 条结果进、1 段文本出）：
  //   输入：[{ title: "Node 22 发布", url: "https://a.com", content: "新增…" },
  //          { title: "LTS 时间表",   url: "https://b.com", content: "计划…" }]
  //   输出：
  //     [1] Node 22 发布
  //     URL: https://a.com
  //     新增…
  //
  //     ---
  //
  //     [2] LTS 时间表
  //     URL: https://b.com
  //     计划…
  //   编号让模型能说「根据 [2]」，分隔线让条目边界清晰、不易串行。
  return data.results
    .map(
      (r, i) =>
        `[${i + 1}] ${r.title}\nURL: ${r.url}\n${r.content}`
    )
    .join("\n\n---\n\n");
}

// ---------------------------------------------------------------------------
// 第二部分：工具定义——递给模型的「工具菜单」（同第二、三章的讲法）
// name 是分机号，description 是说明书——模型凭说明书决定何时拨打、怎么填单。
//
// 本章只有两个工具，职责划分干净利落：
//   web_search   → 继续收集资料（可多次调用，每次换关键词）
//   write_answer → 宣布研究完成、交出答案（terminal tool，同第三章）
// ---------------------------------------------------------------------------

const tools: OpenAI.Chat.ChatCompletionTool[] = [
  // 工具 1：联网搜索。description 里有两句值得注意的话：
  //  -「可以换不同关键词多次调用」——鼓励多轮搜索，别搜一次就交卷；
  //  -「聚焦的关键词比宽泛的好」——顺手教模型怎么写搜索词。
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the web for current information. Use this whenever you need facts, " +
        "recent events, or data you don't know. You can call this multiple times with " +
        "different queries to build a complete picture before writing your answer.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "A specific, focused search query. Narrow queries return better results " +
              "than broad ones — e.g. 'Node.js 22 release date' not 'Node.js news'.",
          },
        },
        required: ["query"],
      },
    },
  },
  // 工具 2：终止工具。模型认为资料足够后调用它「交卷」，
  // 循环借此明确结束（而不是猜 finish_reason）。
  // description 写明「调用此工具将结束研究」——把终止语义写进说明书
  // （同第三章的 write_report），还要求「事实性论断必须附来源 URL」。
  {
    type: "function",
    function: {
      name: "write_answer",
      description:
        "Write your final answer to the research question. Call this only when you have " +
        "gathered enough information from your searches. Include sources (URLs) for any " +
        "factual claims. Calling this ends the research session.",
      parameters: {
        type: "object",
        properties: {
          answer: {
            type: "string",
            description: "Your complete, well-sourced answer in markdown format",
          },
        },
        required: ["answer"],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// 第三部分：parseToolArgs——参数解析（旧相识）
// 和第二、三章一模一样：模型发来的 arguments 是 JSON 字符串（不是对象），
// 必须 JSON.parse；解析失败返回 {}，让后续校验报「缺少参数」、
// 模型下一圈自我纠正，而不是让整个循环崩掉。
// （catch 省略错误变量、as 类型断言的语法细节，见第二章的展开讲解。）
// ---------------------------------------------------------------------------

function parseToolArgs(raw: string): Record<string, string> {
  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// 第四部分：研究型 agent 循环——本章模式的核心
//
// 骨架与 03-agent-loop 完全一致（建议对照读一遍，体会「模式复用」）：
//   模型决定搜什么 → 代码真去搜 → 结果塞回 messages → 模型再判断
//   → 资料够了 write_answer 退出。我们没有写「先搜 A 再搜 B」的剧本。
//
// 这个 demo 防御的两种失败：
//   1. 搜索成瘾——一直搜、迟迟不写答案（MAX_ITERATIONS 保险丝拦住）
//   2. 编造引用——没查到就硬编个 URL 充来源。防它靠两道闸：
//      ① system 提示词明令「只准引用真实搜索结果里的 URL」；
//      ② 搜索结果文本本身就带 URL——模型「有得抄」，编造的动机大减。
//      这不能根除幻觉，但实测能显著减少（05 章还会加上代码级执法）。
//
// 典型迭代流程（示意；实际搜索词由模型现场决定）：
//   第 1 圈：→ web_search("Node.js 22 new features")   ← 5 条结果
//   第 2 圈：→ web_search("Node.js 22 LTS status")     ← 换角度补搜
//   第 3 圈：→ write_answer("Node.js 22 的新特性…")    ← 交卷，循环退出
// ---------------------------------------------------------------------------

async function runResearchAgent(question: string): Promise<string> {
  // 研究型 agent 的循环和 03-agent-loop 几乎一样。
  // 差异只在工具：这次工具不是读 mock 文件，而是搜索网页。
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    {
      // system 提示词 = 这位「研究员」的岗位说明书：角色定位 +
      // 工作方法（一次搜索往往不够）+ 交卷标准（有把握再写答案）。
      // 最后一句是本章重点——「只引用真实搜索结果里的 URL，绝不
      // 编造来源」：防幻觉的第一道闸（第二道是结果文本自带 URL）。
      role: "system",
      content:
        "You are a research assistant. When given a question, search the web to find accurate, " +
        "up-to-date information. Search multiple times with different queries if needed — " +
        "one search is rarely enough for a complete answer. " +
        "Only call write_answer once you are confident in your findings. " +
        "Only cite URLs that appeared in your actual search results — never invent sources.",
    },
    { role: "user", content: question },
  ];

  let finalAnswer: string | null = null;
  // 同第三章：初始 null 表示「答案还没交」，write_answer 分支写入。
  // （let 可重赋值、string | null 联合类型——语法细节见第三章。）
  let iteration = 0;

  console.log(`Question: ${question}\n`);

  // 无限循环：两个出口（模型直接说话 / write_answer 交卷）+ 一道保险丝。
  while (true) {
    iteration++;

    // 保险丝：超上限就抛错——让「任务没完成」响亮地暴露，
    // 而不是悄悄返回半成品（同第三章的讲法）。
    if (iteration > MAX_ITERATIONS) {
      throw new Error(
        `Agent exceeded ${MAX_ITERATIONS} iterations without answering. ` +
          `The model may be stuck in a search loop or the question is too broad.`
      );
    }

    console.log(`[iteration ${iteration}]`);

    // 每圈一次真实模型调用：完整历史 + 工具菜单一起带上。
    // 与 03 相比这行代码零改动——换的只是 tools 数组的内容；
    // 「循环骨架与工具解耦」的好处正在于此。
    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      tools,
      tool_choice: "auto",
    });

    const choice = response.choices[0];
    // 模型这条回复必须进历史（tool 消息要紧跟发起它的 assistant 消息）。
    messages.push(choice.message);

    // 出口 A：模型不再调工具、直接说话（正常走不到，兜底保留，同第三章）。
    if (choice.finish_reason === "stop") {
      console.log();
      return choice.message.content ?? ""; // ?? 空值合并：null 兜成空串（同第三章）
    }

    if (choice.finish_reason === "tool_calls") {
      const toolCalls = choice.message.tool_calls ?? [];

      for (const call of toolCalls) {
        const args = parseToolArgs(call.function.arguments);

        if (call.function.name === "web_search") {
          // 搜索结果会作为 tool 消息放回上下文。
          // 模型下一轮可以基于这些结果决定是否继续搜。
          console.log(`  → web_search("${args.query}")`);
          const results = await webSearch(args.query);
          // 日志只预览前 120 字符防刷屏；进 messages 的是完整结果
          // （三元 + slice 的语法同第三章）。
          const preview = results.length > 120 ? results.slice(0, 120) + "…" : results;
          console.log(`  ← ${preview}`);
          messages.push({ role: "tool", tool_call_id: call.id, content: results });
        } else if (call.function.name === "write_answer") {
          // terminal tool：模型认为资料足够后调用它。
          // 这样循环可以明确结束，而不是靠猜 finish_reason。
          if (!args.answer) {
            // 缺参数：把错误作为 tool 结果退回，模型下一圈补上重来
            // （continue = 跳过本轮循环剩余部分，去处理下一个 call）。
            messages.push({ role: "tool", tool_call_id: call.id, content: "Missing required argument: answer" });
            continue;
          }
          finalAnswer = args.answer;
          console.log(`  → write_answer (${finalAnswer.length} chars)\n`);
          messages.push({ role: "tool", tool_call_id: call.id, content: "Answer saved." });
          // 出口 B：先补齐 tool 应答再返回，保持 messages 合法（同第三章）。
          return finalAnswer;
        } else {
          // Model hallucinated a tool name — return a clear error so it recovers.
          // 模型幻觉出不存在的工具名：退回明确错误，让它下一圈自纠。
          messages.push({ role: "tool", tool_call_id: call.id, content: `Unknown tool: "${call.function.name}"` });
        }
      }

      console.log();
      // 干完这圈的活回到 while 顶部：带着搜索结果，让模型想「还缺什么」。
    }
  }
}

// ---------------------------------------------------------------------------
// 第五部分：Demo——问一个模型「书里没有」的问题
// ---------------------------------------------------------------------------

async function main() {
  // 精心挑选的问题：「Node.js 22 有哪些值得关注的新特性？它进入 LTS 了吗？」
  // 为什么选它：
  //  - Node.js 22 发布于 2024 年 4 月、当年 10 月进入 LTS——晚于多数模型
  //    的训练截止日期，正好考住那本「过期百科全书」；
  //  - 问题自带两问（特性 + LTS 状态），会逼出「多次搜索、各自补齐」
  //    的研究行为——一轮搜索通常只答得了一半。
  //
  // 📤 输入输出走查（控制台预期输出，大意；搜索词与圈数每次运行会有差异）：
  //
  //   Question: What are the most notable new features in Node.js 22, and is it LTS yet?
  //
  //   [iteration 1]
  //     → web_search("Node.js 22 major new features")
  //        ↑ 模型自己拆题：先攻「新特性」这半问
  //     ← [1] Node.js 22 is now available!
  //       URL: https://nodejs.org/en/blog/announcements/v22-release-announce…
  //       （日志只预览 120 字符；完整 5 条结果已进 messages）
  //
  //   [iteration 2]
  //     → web_search("Node.js 22 LTS release date")
  //        ↑ 读完第一轮结果，发现「是否 LTS」还没准信，换个角度补搜
  //     ← [1] Node.js 22 enters active LTS …
  //
  //   [iteration 3]
  //     → write_answer (947 chars)
  //        ↑ 两问都有据可依 → 交卷（terminal tool），循环在这里返回
  //
  //   ─────────────────────────────────────
  //
  //   Answer:
  //   Node.js 22 的主要新特性：
  //   - 内置 WebSocket 客户端，无需第三方库
  //   - require() 可以同步加载 ESM 模块
  //   - …
  //   LTS 状态：2024 年 10 月起进入 LTS（代号 "Jod"）。
  //   来源：https://nodejs.org/en/blog/announcements/v22-release-announce …
  //
  // 三个值得体会的点：
  //  1. 拆题、补搜的顺序都是模型自己定的——没有「先搜特性再搜 LTS」的剧本；
  //  2. 答案里的 URL 全部来自搜索结果文本（提示词禁令 + 结果自带 URL，
  //     双重作用下模型「有得抄」就不会凭空编）；
  //  3. 圈数与搜索词每次可能不同——流程确定，路径不确定（agent 的常态，
  //     第三章已见过；后面的模块会专门讲怎么给这种不确定性加护栏）。
  const answer = await runResearchAgent(
    "What are the most notable new features in Node.js 22, and is it LTS yet?"
  );

  console.log("─".repeat(60));
  console.log("\nAnswer:\n");
  console.log(answer);
}

// 顶层兜底：任何一圈抛出的错（含保险丝熔断的「超过最大迭代」）
// 都在这里被接住、打到控制台。
main().catch(console.error);
