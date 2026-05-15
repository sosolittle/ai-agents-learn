import "dotenv/config";
import OpenAI from "openai";
import { parse } from "node-html-parser";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;

const MAX_ITERATIONS = 10;
// Keep scraped pages bounded so one URL cannot flood the model context.
const MAX_SCRAPED_CHARS = 8000;

interface TavilyResult {
  title: string;
  url: string;
  content: string;
}

interface TavilyResponse {
  results: TavilyResult[];
}

async function webSearch(query: string): Promise<string> {
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

  if (!response.ok) {
    return `Search failed: ${response.status} ${response.statusText}`;
  }

  const data = (await response.json()) as TavilyResponse;

  if (!data.results?.length) {
    return "No results found for that query.";
  }

  return data.results
    .map(
      (r, i) =>
        `[${i + 1}] ${r.title}\nURL: ${r.url}\n${r.content}`
    )
    .join("\n\n---\n\n");
}

async function scrapePage(url: string): Promise<string> {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; research-agent/1.0)",
      },
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) {
      return `Fetch failed: ${response.status} ${response.statusText}`;
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html")) {
      return `Skipped: not an HTML page (content-type: ${contentType})`;
    }

    const html = await response.text();
    const root = parse(html);

    // Remove chrome and hidden DOM before extracting text so the model reads content, not menus.
    root.querySelectorAll("script, style, nav, footer, header, aside, [aria-hidden='true']")
      .forEach(el => el.remove());

    const text = root.structuredText
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    return text.length > MAX_SCRAPED_CHARS
      ? text.slice(0, MAX_SCRAPED_CHARS) + "\n\n[truncated — page content exceeds limit]"
      : text;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Scrape error: ${msg}`;
  }
}

const tools: OpenAI.Chat.ChatCompletionTool[] = [
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
  {
    type: "function",
    function: {
      name: "scrape_page",
      description:
        "Fetch a URL and return the full readable text of the page. Use this after " +
        "web_search when you need the complete content of a specific page — not just the " +
        "excerpt. Useful when the search snippet is too short to answer the question. " +
        "Avoid scraping URLs that are likely paywalled, login-required, or PDFs.",
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

function parseToolArgs(raw: string): Record<string, string> {
  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

async function runResearchAgent(question: string): Promise<string> {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    {
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

  let finalAnswer: string | null = null;
  let iteration = 0;

  console.log(`Question: ${question}\n`);

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
          const results = await webSearch(args.query);
          const preview = results.length > 120 ? results.slice(0, 120) + "…" : results;
          console.log(`  ← ${preview}`);
          messages.push({ role: "tool", tool_call_id: call.id, content: results });
        } else if (call.function.name === "scrape_page") {
          if (!args.url) {
            messages.push({ role: "tool", tool_call_id: call.id, content: "Missing required argument: url" });
            continue;
          }
          console.log(`  → scrape_page("${args.url}")`);
          const content = await scrapePage(args.url);
          const preview = content.length > 120 ? content.slice(0, 120) + "…" : content;
          console.log(`  ← ${preview}`);
          messages.push({ role: "tool", tool_call_id: call.id, content });
        } else if (call.function.name === "write_answer") {
          if (!args.answer) {
            messages.push({ role: "tool", tool_call_id: call.id, content: "Missing required argument: answer" });
            continue;
          }
          finalAnswer = args.answer;
          console.log(`  → write_answer (${finalAnswer.length} chars)\n`);
          messages.push({ role: "tool", tool_call_id: call.id, content: "Answer saved." });
          return finalAnswer;
        } else {
          messages.push({ role: "tool", tool_call_id: call.id, content: `Unknown tool: "${call.function.name}"` });
        }
      }

      console.log();
    }
  }
}

async function main() {
  const answer = await runResearchAgent(
    "What exactly does the TC39 Temporal proposal change about how JavaScript handles dates and timezones? I want the technical details, not a summary."
  );

  console.log("─".repeat(60));
  console.log("\nAnswer:\n");
  console.log(answer);
}

main().catch(console.error);
