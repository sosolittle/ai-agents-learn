// ============================================================
//  第五章：scrape-page（搜索 + 抓取网页 agent）
//
//  🏠 生活化比喻（接着第四章的故事讲）：
//  第四章的电话咨询台（搜索）只会「念摘要」：标题、地址、
//  相关段落，每条念三句。想要细节？新员工只能把地址抄在纸上。
//  这一章，我们允许他亲自跑一趟，把那页文件整份借回来复印
//  （scrape_page 抓取网页全文）。能力升级，麻烦也跟着来了：
//
//   ① 他能去任何地址吗？——不能。只能去「咨询台报过的地址」。
//      代码里维护一张名册（allowedScrapeUrls）：搜索返回过的 URL
//      才能进册；他自己随口报的地址一律驳回。
//      就像快递员只能送「订单上确认过的地址」，不能中途自己加塞。
//   ② 自家机房能进吗？——更不能。他是用你公司的网络跑腿的：
//      若他说想去 localhost、内网 IP、云服务器元数据接口转转，
//      等于拿着你的工牌进自家机房——这就是 SSRF（服务端请求伪造）。
//      安检员 validateScrapeUrl 专门拦这类地址。
//   ③ 整份文件都塞给他吗？——不行。一个网页动辄几万字符，
//      全塞会把工作记录本（messages）撑爆、注意力冲散。
//      所以只「复印」前 8000 字符（MAX_SCRAPED_CHARS）。
//
//  学习目标：
//  1. 分清「搜索摘要」和「完整网页内容」，知道什么时候需要后者
//  2. 看懂 allowlist 如何用代码（而非嘴上约定）限制抓取范围
//  3. 认识 SSRF：为什么 agent 不能随便抓任意 URL
//  4. 学会清洗页面噪音 + 裁剪正文，别让一个网页淹没模型
//
//  核心结论：
//  给 agent 加新能力 = 给系统开新攻击面。抓网页比搜索更危险，
//  因为它让你的服务器主动去访问外部（甚至内部）地址——
//  URL allowlist、协议限制、内网拦截、超时与长度上限，一个都不能少。
// ============================================================

import "dotenv/config";
import OpenAI from "openai";
// node-html-parser：把 HTML 文本解析成一棵可查询的树（DOM），
// 之后就能用 CSS 选择器挑出不要的元素删掉。浏览器里的
// document.querySelector 在 Node 里不存在，这个包就是平替。
import { parse } from "node-html-parser";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;

const MAX_ITERATIONS = 10;
// Keep scraped pages bounded so one URL cannot flood the model context.
const MAX_SCRAPED_CHARS = 8000;
// 抓取后的正文最多放 8000 个字符进上下文。
// 这是成本控制，也是防止网页内容“淹没”模型注意力。
// （类比：一份 100 页的文件，只复印前 20 页给新员工做笔记。）

// ---------------------------------------------------------------------------
// 第一部分：搜索——复用第四章的能力，但多带回一份「地址清单」
// （fetch / JSON.stringify / response.json 的语法讲解见第四章，此处不重复。）
// ---------------------------------------------------------------------------

// （这两个接口和第四章一模一样——描述 Tavily 响应的形状。）
interface TavilyResult {
  title: string;
  url: string;
  content: string;
}

interface TavilyResponse {
  results: TavilyResult[];
}

// webSearch returns both formatted text for the model and the raw URL list so
// the agent loop can build an allowlist of URLs the model is actually allowed
// to scrape (only URLs the search returned, not arbitrary ones).
// 与 04 的关键差异：搜索函数现在返回「一托二」的对象——
//   formattedText：给模型看的排版文本（进 messages）
//   urls：         原始地址清单（进名册；模型看不到这个字段）
// TS 语法：一个函数要返回多个值，惯用法是打包成对象返回；
// 调用方再用「解构」接住（见下面循环里的 const { formattedText, urls } = …）。
interface WebSearchOutput {
  formattedText: string;
  urls: string[];
}

async function webSearch(query: string): Promise<WebSearchOutput> {
  // 搜索函数除了返回给模型看的 formattedText，
  // 还返回原始 urls，供 agent loop 建立“允许抓取列表”。
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: TAVILY_API_KEY,
      query,
      max_results: 5,
      search_depth: "basic",
    }),
  });

  // 失败路径同样「文本给原因、名册进空单」——一个 URL 都不许抓。
  if (!response.ok) {
    return { formattedText: `Search failed: ${response.status} ${response.statusText}`, urls: [] };
  }

  const data = (await response.json()) as TavilyResponse;

  if (!data.results?.length) {
    return { formattedText: "No results found for that query.", urls: [] };
  }

  // 排版部分与 04 完全相同：编号 + URL + 摘录，分隔线隔开。
  const formattedText = data.results
    .map(
      (r, i) =>
        `[${i + 1}] ${r.title}\nURL: ${r.url}\n${r.content}`
    )
    .join("\n\n---\n\n");

  // 另外单独抽一份数组：只取地址，供名册登记。
  // （.map(r => r.url)：从每个结果对象里挑出 url 字段，组成新数组。）
  const urls = data.results.map((r) => r.url);

  // TS 语法：简写属性——变量名恰好和字段名相同，
  // { formattedText, urls } 等价于 { formattedText: formattedText, urls: urls }。
  return { formattedText, urls };
}

// ---------------------------------------------------------------------------
// 第二部分：地址安检——normalizeUrl + validateScrapeUrl
// 抓取前的两道手续：先把地址「标准化」，再过「安全检查」。
// ---------------------------------------------------------------------------

// Normalizes a URL string using the WHATWG URL parser so that the allowlist
// comparison is canonical. Returns null if the string is not a valid URL.
// Using parsed.href means "http://example.com" and "http://example.com/"
// resolve to the same string, preventing trivial bypass attempts.
// 「标准化」：同一个地址有一堆等价写法——
//   https://a.com ≡ https://a.com/ ≡ HTTPS://A.COM/
// 拿原始字符串直接比名册，写法稍有差异就会误判「不在册」，
// 甚至被刻意构造的差异绕过。所以先统一成标准形态再比。
//
// TS 语法：new URL(字符串) 是 JS 内置的地址解析器（WHATWG 标准，
// 浏览器和 Node 都有）。解析不了会 throw，所以用 try/catch 包住、
// 失败返回 null——null 在这里当「解析不了」的信号。
// 返回类型 string | null = 「要么 string 要么 null」的联合类型。
function normalizeUrl(rawUrl: string): string | null {
  // URL 字符串有很多等价写法。先标准化再比较，
  // 可以减少误拒绝，也能降低绕过 allowlist 的风险。
  try {
    return new URL(rawUrl).href; // .href = 解析后重新拼出的「标准形态」
  } catch {
    return null;
  }
}

// Checks whether a URL is safe to fetch. Returns null if safe, or an error
// message string if rejected. Blocks localhost and private IP ranges to reduce
// accidental SSRF-style risk — this is a teaching example, not a hardened
// production crawler.
// 「安检员」：判断一个 URL 能不能抓。
// 返回约定：null = 放行；字符串 = 拒绝原因。
// （用返回值当信号而不是抛错，调用方好处理。）
//
// 安检项目逐层下查，任何一层不过就出局：
//   ① 格式合法（URL 解析器能读懂）
//   ② 协议只允许 http/https（挡住 file:、javascript: 之类）
//   ③ 主机名不是 localhost / ::1 / 0.0.0.0（「自家工位」）
//   ④ 主机名不是内网 IP 段（「自家机房」的各个分区）
// ⚠️ 这是教学示例的简化安检：真实爬虫还要防 DNS 重绑定、IPv6 映射
//    等绕过手法。先理解「为什么要查这些」，再谈「查得多严」。
function validateScrapeUrl(rawUrl: string): string | null {
  // 这是抓取工具的第一道安全检查。
  // 返回 null 表示通过；返回字符串表示拒绝原因。
  let parsed: URL;
  // TS 语法：先声明、后赋值（分两步写）。赋值在 try 里，失败路径
  // 直接 return 了；TS 的「明确赋值分析」确认后续用到的分支必然赋过值。
  try {
    parsed = new URL(rawUrl);
  } catch {
    return "Invalid URL.";
  }

  // ② 协议白名单。注意 parsed.protocol 自带冒号：如 "https:"、"file:"。
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `Unsupported protocol "${parsed.protocol}" — only http and https are allowed.`;
  }

  // 主机名统一转小写再比（"Example.COM" 和 "example.com" 是同一家）。
  const host = parsed.hostname.toLowerCase();

  // Reject well-known internal hostnames.
  // ③ 「自家工位」黑名单：localhost（本机域名）、::1（IPv6 版本机）、
  // 0.0.0.0（「所有网卡」意义上的本机地址）。
  if (host === "localhost" || host === "::1" || host === "0.0.0.0") {
    return `Blocked host "${host}" — internal addresses are not allowed.`;
  }

  // Reject the AWS metadata endpoint and loopback / private IP ranges.
  // ④ 「自家机房」按 IP 段拉黑。下面四段能用「前缀匹配」一刀切：
  //   "127."     → 127.0.0.0/8    回环（本机）
  //   "10."      → 10.0.0.0/8     大型企业内网
  //   "169.254." → 链路本地段。云服务器的「元数据接口」
  //                （169.254.169.254）就藏在这段——agent 一旦被诱导
  //                访问它，可能直接拿到云上的临时凭证，是 SSRF 的经典目标
  //   "192.168." → 192.168.0.0/16 家用路由器 / 办公室内网
  const blockedPrefixes = [
    "127.",        // 127.0.0.0/8  loopback
    "10.",         // 10.0.0.0/8   private
    "169.254.",    // 169.254.0.0/16  link-local (AWS metadata at 169.254.169.254)
    "192.168.",    // 192.168.0.0/16  private
  ];

  for (const prefix of blockedPrefixes) {
    // TS 语法：startsWith("10.") = 「以 "10." 开头吗？」，返回布尔值。
    if (host.startsWith(prefix)) {
      return `Blocked host "${host}" — private/internal network addresses are not allowed.`;
    }
  }

  // 172.16.0.0/12 covers 172.16.x.x – 172.31.x.x
  // 172 段没法用前缀匹配：172.16.0.0/12 覆盖的是第二个数字 16~31 的范围，
  // 提取不出统一前缀（写 "172.1" 会误伤 172.1.x.x ~ 172.9.x.x 这些公网地址），
  // 所以这里换正则出场。
  //
  // TS 语法：正则 /^172\.(\d+)\./ 逐字拆解——
  //   ^       从字符串开头匹配
  //   172\.   字面的 "172."（\. 是转义的点；不转义的 . 会匹配任意字符）
  //   (\d+)   连续数字打包成「捕获组」——正是要检查的第二个数字
  //   \.      后面还得跟一个点，确保整体是 "172.16." 这种 IP 形态
  // host.match(正则) 返回数组（命中时）或 null；
  // 命中时 match172[1] 就是捕获组抓到的文本（如 "16"）。
  const match172 = host.match(/^172\.(\d+)\./);
  if (match172) {
    // parseInt("16", 10)：把文本 "16" 变成数字 16（第二个参数 10 = 十进制）。
    const second = parseInt(match172[1], 10);
    if (second >= 16 && second <= 31) {
      // 落在 16~31 → 是内网地址（172.16.x.x ~ 172.31.x.x），拒绝。
      return `Blocked host "${host}" — private/internal network addresses are not allowed.`;
    }
  }

  // 全部安检通过：null = 放行。
  return null;
}

// ---------------------------------------------------------------------------
// 第三部分：scrapePage——抓网页的四步流水线
// 安检 → 抓取 → 清洗 → 裁剪。任何一步出问题都「返回带原因的文本」
// 而不是抛错——原因会作为 tool 结果回到模型，让它能调整策略。
// ---------------------------------------------------------------------------

async function scrapePage(url: string): Promise<string> {
  // scrapePage 是真正访问网页的工具。
  // 它先做安全校验，再 fetch，再解析 HTML，最后抽取正文文本。
  // Safety check before we ever open a network connection.
  // 第 0 步·安检：先过 validateScrapeUrl，再开网络连接——
  // 顺序很重要：安检在「握手」之前，不给危险地址任何网络机会。
  const validationError = validateScrapeUrl(url);
  if (validationError) return `Rejected: ${validationError}`;

  try {
    // redirect: "manual" means we receive the redirect response as-is instead
    // of following it automatically. Production crawlers can follow redirects,
    // but they must validate every redirect target before fetching — this demo
    // skips that complexity and surfaces the redirect destination instead.
    // ⚠️ 为什么不自动跟跳转：跳转目标是个「安检没查过的新地址」，
    // 自动跟随 = 给绕过留后门。教学示例选择「收到跳转就停下」，
    // 把目标地址作为文本告知模型——想抓请走搜索 → 进名册 → 再安检的
    // 正规流程。
    const response = await fetch(url, {
      headers: {
        // User-Agent：自报家门。有些网站只对「浏览器」响应，
        // 报一个诚实的研究机器人身份，比伪装成 Chrome 得体。
        "User-Agent": "Mozilla/5.0 (compatible; research-agent/1.0)",
      },
      redirect: "manual",
      // 超时保险：8 秒没响应就中止。没有它，一个挂死的网站
      // 能把整个 agent 拖在 await 上卡死。
      signal: AbortSignal.timeout(8000),
    });

    // 3xx = 跳转（301 永久搬家 / 302 临时搬家…）。
    // redirect: "manual" 让跳转响应原样到手，而不是被 fetch 悄悄带走。
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        return `Skipped: page returned redirect status ${response.status} without a Location header.`;
      }
      return (
        `Skipped: page redirects to ${location}. ` +
        `This demo does not follow redirects automatically so redirect targets cannot bypass URL validation.`
      );
    }

    if (!response.ok) {
      // 4xx/5xx：地址合法但拿不到（404 不存在、403 拒绝访问、500 服务器炸了…）。
      return `Fetch failed: ${response.status} ${response.statusText}`;
    }

    // 内容类型检查：只接受 HTML。要是拿到 PDF/图片/JSON，
    // 硬读会产出一堆乱码白占上下文——不如明确告诉模型「这不是网页」。
    // headers.get() 拿不到该头时返回 null，?? "" 兜成空串再做 includes。
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html")) {
      return `Skipped: not an HTML page (content-type: ${contentType})`;
    }

    // 第 1 步·抓取完成：拿到 HTML 原文（可能几万字符）。
    const html = await response.text();
    // 第 2 步·解析：HTML 文本 → 可查询的 DOM 树。
    const root = parse(html);

    // Remove chrome and hidden DOM before extracting text so the model reads content, not menus.
    // 第 3 步·清洗：摘掉「页面家具」。引号里是一串 CSS 选择器
    // （前端同学的老朋友）：script/style（脚本与样式）、nav/footer/
    // header/aside（导航、页脚、页头、侧边栏）、[aria-hidden='true']
    // （无障碍标准里标记「对读屏隐藏」的元素）。摘掉家具，剩下的才是正文。
    // forEach(el => el.remove())：对选中的每个节点执行「从树上摘除」。
    root.querySelectorAll("script, style, nav, footer, header, aside, [aria-hidden='true']")
      .forEach(el => el.remove());

    // 第 3.5 步·抽取 + 压空白：structuredText 取出树里的可见文字；
    // 正则 /\n{3,}/g = 「3 个及以上连续换行」（{3,} 是量词，g = 全局），
    // 统一压成 2 个换行；trim() 去掉首尾空白。
    const text = root.structuredText
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    // Prefix every successful scrape with its source URL so the model always
    // knows which page the content came from, even deep inside a long context.
    // 第 4 步·裁剪：超长就截断并注明（三元 + slice，同前几章）。
    // 每份抓取结果以 SOURCE_URL 开头——哪怕聊到几十轮之后，
    // 模型也记得「这段话出自哪个页面」，引用来源时不会张冠李戴。
    const body = text.length > MAX_SCRAPED_CHARS
      ? text.slice(0, MAX_SCRAPED_CHARS) + "\n\n[truncated — page content exceeds limit]"
      : text;

    return `SOURCE_URL: ${url}\n\n${body}`;
  } catch (err: unknown) {
    // 兜底网：超时（AbortSignal）、DNS 解析失败、连接被重置……都落到这。
    // TS 语法：err 标成 unknown = 「来了个不知道是什么的东西」，
    // 不能直接读属性；instanceof Error 先验明正身，是真 Error 才能
    // 安全取 .message，否则 String(err) 转成文本兜底。
    const msg = err instanceof Error ? err.message : String(err);
    return `Scrape error: ${msg}`;
  }
}

// ---------------------------------------------------------------------------
// 第四部分：工具定义——三个工具串成一条研究流水线
//   1. web_search  找候选来源（顺带把 URL 登记进名册）
//   2. scrape_page 把某个候选来源的全文取回来
//   3. write_answer 交卷（terminal tool）
// 注意 scrape_page 的 description 写着「只接受此前 web_search 返回的
// URL」——但真正执法的不是这句提示，而是循环里的名册检查。
// 嘴上约定引导行为，代码执法守住底线。
// ---------------------------------------------------------------------------

const tools: OpenAI.Chat.ChatCompletionTool[] = [
  // 工具 1：搜索。同第四章——「可多次调用」「关键词要聚焦」都写在说明书里。
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
  // 工具 2：抓取全文。description 的三处措辞值得看：
  //  - 「在 web_search 之后用」：先有候选，再取全文；
  //  - 「摘要太短不足以回答时」：点明使用时机，避免逢结果必抓；
  //  - 「避开可能付费墙 / 需登录 / PDF 的页面」+「只接受搜索返回的 URL」：
  //    把负面清单也写进说明书，减少无效抓取。
  {
    type: "function",
    function: {
      name: "scrape_page",
      description:
        "Fetch a URL and return the full readable text of the page. Use this after " +
        "web_search when you need the complete content of a specific page — not just the " +
        "excerpt. Useful when the search snippet is too short to answer the question. " +
        "Avoid scraping URLs that are likely paywalled, login-required, or PDFs. " +
        "Only URLs returned by a prior web_search call are accepted.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "The exact URL to fetch — must come from a prior web_search result",
          },
        },
        required: ["url"],
      },
    },
  },
  // 工具 3：终止工具（同第四章）。
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
// 第五部分：parseToolArgs——参数解析（旧相识，见第二、四章的讲解）
// ---------------------------------------------------------------------------

function parseToolArgs(raw: string): Record<string, string> {
  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// 第六部分：研究 agent 循环——在 04 的骨架上加一道「抓取闸门」
//
// 与 04 的代码差异集中在两处：
//   ① 多了名册 allowedScrapeUrls（Set）：web_search 的结果 URL
//     标准化后登记进册；只进不出，所以名册单调增长。
//   ② scrape_page 分支先查名册再放行——不在册的 URL 直接驳回，
//     驳回原因作为 tool 结果退回模型，它下一圈自会改用正规来源。
//
// 📤 输入输出走查（名册怎么运转）：
//   第 1 圈 web_search("TC39 Temporal proposal")
//     → 结果带 5 个 URL，标准化后进册：
//       名册 = { "https://tc39.es/proposal-temporal/",
//               "https://github.com/tc39/proposal-temporal/", … }
//   第 2 圈 scrape_page("https://tc39.es/proposal-temporal/")
//     → normalizeUrl 后在册 → 放行，全文进 messages
//   若模型把大小写写飘了：scrape_page("HTTPS://TC39.ES/proposal-temporal/")
//     → 标准化统一成小写形态 → 仍在册 → 照样放行（避免「写法差异」误拒）
//   若模型幻觉：scrape_page("https://evil.example.com/stolen")
//     → 标准化后不在册 → [REJECTED]，拒绝原因退回模型 → 循环继续，
//       一次失败被「对话」消化，而不是崩掉
// ---------------------------------------------------------------------------

async function runResearchAgent(question: string): Promise<string> {
  // 这里的 agent 比 04-web-search 多了一个关键状态：
  // allowedScrapeUrls。它记录哪些 URL 是搜索结果真实返回过的。
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    {
      // system 提示词 = 岗位说明书，比 04 多交代了「什么时候抓全文」：
      // 搜索结果相关但摘要太短 → 抓原文。引用规则同 04：
      // 只准引用真实搜索 / 抓取过的 URL。
      role: "system",
      content:
        "You are a research assistant with two tools: web_search and scrape_page. " +
        "Start by searching for the topic. When a search result looks highly relevant but the snippet is too short, " +
        "use scrape_page on that specific URL to read the full content. " +
        "Search multiple times if needed. Only call write_answer when confident. " +
        "Only cite URLs from your actual search results or scraped pages — never invent sources.",
    },
    { role: "user", content: question },
  ];

  // Only URLs that came back from web_search may be passed to scrape_page.
  // This is enforced by code, not just by instruction — the agent loop checks
  // this set before calling scrapePage, and rejects any URL not in it.
  // URLs are stored in canonical form (parsed.href) so the comparison is
  // stable regardless of minor formatting differences.
  // 抓取名册：登记所有「搜索结果真实出现过的 URL」。
  // 这条规则由代码执法，不靠嘴上约定——循环在调用 scrapePage 前查它，
  // 不在册的 URL 一律驳回。地址以标准形态（href）入册，比对才稳定。
  //
  // TS 语法：Set<string> = 「集合」：只关心「在不在」，不关心顺序、
  // 自动去重。add() 登记、has() 查询都极快。当名册用正合适
  // （数组的 includes 查询要一个个扫，慢，且不去重）。
  const allowedScrapeUrls = new Set<string>();

  let finalAnswer: string | null = null;
  let iteration = 0;
  // （finalAnswer / iteration 的类型与语义，同第三、四章。）

  console.log(`Question: ${question}\n`);

  // 无限循环：出口与保险丝同 04，下面只在差异处加注释。
  while (true) {
    iteration++;

    if (iteration > MAX_ITERATIONS) {
      throw new Error(
        `Agent exceeded ${MAX_ITERATIONS} iterations without answering. ` +
          `The model may be stuck in a search loop or the question is too broad.`
      );
    }

    console.log(`[iteration ${iteration}]`);

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      tools,
      tool_choice: "auto",
    });

    const choice = response.choices[0];
    messages.push(choice.message);

    if (choice.finish_reason === "stop") {
      console.log();
      return choice.message.content ?? "";
    }

    if (choice.finish_reason === "tool_calls") {
      const toolCalls = choice.message.tool_calls ?? [];

      for (const call of toolCalls) {
        const args = parseToolArgs(call.function.arguments);

        if (call.function.name === "web_search") {
          console.log(`  → web_search("${args.query}")`);
          // TS 语法：解构赋值——按字段名把返回对象的两个值直接拆进
          // 两个变量。等价于：
          //   const output = await webSearch(args.query);
          //   const formattedText = output.formattedText;
          //   const urls = output.urls;
          const { formattedText, urls } = await webSearch(args.query);

          // Register every URL this search returned in canonical form so
          // scrape_page can use them. normalizeUrl filters out any malformed
          // entries the search API might return.
          // 登记：本轮搜索返回的每个 URL 标准化后进名册。
          // normalizeUrl 顺手滤掉搜索 API 偶尔吐出的畸形地址（null 不入册）。
          for (const url of urls) {
            const normalized = normalizeUrl(url);
            if (normalized) allowedScrapeUrls.add(normalized);
          }

          // 日志只预览 120 字符；完整文本进 messages（同第四章）。
          const preview = formattedText.length > 120 ? formattedText.slice(0, 120) + "…" : formattedText;
          console.log(`  ← ${preview}`);
          messages.push({ role: "tool", tool_call_id: call.id, content: formattedText });
        } else if (call.function.name === "scrape_page") {
          // 抓取分支：先查名册，再放行——本章的代码级执法点。
          if (!args.url) {
            messages.push({ role: "tool", tool_call_id: call.id, content: "Missing required argument: url" });
            continue;
          }

          // Normalize the requested URL before allowlist lookup so that trivial
          // differences (trailing slash, percent-encoding) do not cause spurious
          // rejections or bypasses.
          // 请求的 URL 也先标准化再查名册——写法差异（大小写、编码）
          // 才不会造成误拒或绕过。
          const normalizedRequestedUrl = normalizeUrl(args.url);

          // Enforce the allowlist: the URL must have appeared in a prior web_search result.
          // 闸门：解析失败（null）或不在册 → 驳回。驳回原因退回模型，
          // 它下一圈会看到原因并改用搜索结果里的地址——失败在对话里消化。
          if (!normalizedRequestedUrl || !allowedScrapeUrls.has(normalizedRequestedUrl)) {
            console.log(`  → scrape_page("${args.url}") [REJECTED — not in search results]`);
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: "Rejected: scrape_page can only fetch URLs returned by a prior web_search result.",
            });
            continue;
          }

          console.log(`  → scrape_page("${args.url}")`);
          const content = await scrapePage(normalizedRequestedUrl);
          const preview = content.length > 120 ? content.slice(0, 120) + "…" : content;
          console.log(`  ← ${preview}`);
          messages.push({ role: "tool", tool_call_id: call.id, content });
        } else if (call.function.name === "write_answer") {
          // 终止工具（同第四章）：先校验参数，写入 finalAnswer，
          // 补齐 tool 应答后返回，循环结束。
          if (!args.answer) {
            messages.push({ role: "tool", tool_call_id: call.id, content: "Missing required argument: answer" });
            continue;
          }
          finalAnswer = args.answer;
          console.log(`  → write_answer (${finalAnswer.length} chars)\n`);
          messages.push({ role: "tool", tool_call_id: call.id, content: "Answer saved." });
          return finalAnswer;
        } else {
          // 模型幻觉出不存在的工具名：退回明确错误，让它下一圈自纠（同前几章）。
          messages.push({ role: "tool", tool_call_id: call.id, content: `Unknown tool: "${call.function.name}"` });
        }
      }

      console.log();
    }
  }
}

// ---------------------------------------------------------------------------
// 第七部分：Demo——问一个「摘要喂不饱」的问题
// ---------------------------------------------------------------------------

async function main() {
  // 问题也经过挑选：「TC39 的 Temporal 提案到底改了 JS 处理日期和
  // 时区的哪些方面？要技术细节，不要概述。」
  // 为什么选它：
  //  - 搜索摘要通常只有两三句（「Temporal 是更现代的日期时间 API」），
  //    满足不了「技术细节」的要求——逼模型去抓提案原文来读；
  //  - 提案官网 tc39.es 和 GitHub 仓库公开、稳定、正文密度高，
  //    正适合 scrape_page 演示；
  //  - 写前端的都被 Date 的坑折磨过（月份从 0 数、时区一团乱、
  //    对象可变），借这个 demo 顺便看看 Temporal 怎么救。
  //
  // 📤 输入输出走查（控制台预期输出，大意；实际路径由模型现场决定）：
  //
  //   Question: What exactly does the TC39 Temporal proposal change about how
  //   JavaScript handles dates and timezones? I want the technical details, not a summary.
  //
  //   [iteration 1]
  //     → web_search("TC39 Temporal proposal technical details")
  //     ← [1] Temporal proposal - TC39
  //       URL: https://tc39.es/proposal-temporal/…
  //       （5 条结果的完整文本进 messages；URL 同时登记进名册）
  //
  //   [iteration 2]
  //     → scrape_page("https://tc39.es/proposal-temporal/")
  //        ↑ 摘要只有一句「fixes dates and times in JavaScript」——
  //          模型判断不够答「技术细节」，决定把提案首页整页取回
  //     ← SOURCE_URL: https://tc39.es/proposal-temporal/
  //       Temporal is a proposed global object…
  //       （清洗 + 裁剪后的正文，最多 8000 字符；日志只预览 120 字符）
  //
  //   [iteration 3]
  //     → web_search("Temporal.ZonedDateTime timezone handling")
  //        ↑ 读完原文发现时区部分还想再补料，换个关键词再搜
  //     ← …（新 URL 继续进名册）
  //
  //   [iteration 4]
  //     → write_answer (1800+ chars)
  //        ↑ 细节足够 → 交卷
  //
  //   ─────────────────────────────────────
  //
  //   Answer:
  //   # Temporal 提案的技术要点
  //   - 不可变性：所有 Temporal 对象创建后不可修改（Date 的 setMonth
  //     那种「原地改自己」是无数 bug 的源头）
  //   - 时区成为一等公民：ZonedDateTime 同时携带时刻、时区、历法
  //   - 月份从 1 数起、API 命名更直观（PlainDate / PlainTime / …）
  //   - …
  //   来源：https://tc39.es/proposal-temporal/ …
  //
  // 三个值得体会的点：
  //  1. 「摘要不够就抓原文」是模型对比「问题要求」和「已到手信息」
  //     之后自己做的判断——我们没写任何「何时抓取」的剧本；
  //  2. 名册全程静默运转：正常路径上你感知不到它，只有当模型试图抓
  //     搜索结果之外的 URL 时才亮红灯（想看效果，可以故意把 system
  //     提示词改松一点再跑）；
  //  3. 每份抓取内容以 SOURCE_URL 开头——答案末尾的来源清单因此
  //     能一一对应上号，这也是防「编造引用」的第三道暗桩。
  const answer = await runResearchAgent(
    "What exactly does the TC39 Temporal proposal change about how JavaScript handles dates and timezones? I want the technical details, not a summary."
  );

  console.log("─".repeat(60));
  console.log("\nAnswer:\n");
  console.log(answer);
}

// 顶层兜底：任何一圈抛出的错（含保险丝熔断）都在这里接住、打到控制台。
main().catch(console.error);
