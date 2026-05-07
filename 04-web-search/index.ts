// Web search agent: the model searches the web to answer a research question.
// The key insight: web_search is just another tool — a function that returns a
// string. The model decides when to call it and how many times. You never
// script the sequence. Same loop as 03-agent-loop, different tools.

import "dotenv/config";
import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;

const MAX_ITERATIONS = 10;

// ---------------------------------------------------------------------------
// Tavily web search — the only real I/O in this file.
//
// Tavily is a search API built for LLM agents. It returns clean text snippets
// rather than raw HTML, so the model can read results directly without parsing.
//
// What comes back per result:
//   { title, url, content }   ← content is the relevant excerpt, not the page
//
// We cap at 5 results. More results = bigger context = slower, more expensive.
// The model will search again if it needs more — that's the point of the loop.
// ---------------------------------------------------------------------------

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
      // search_depth: "basic" is faster; "advanced" re-ranks results but costs more quota
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

  // Format results as plain text — the model reads this, not JSON.
  // Each result gets a separator so the model can tell where one ends.
  return data.results
    .map(
      (r, i) =>
        `[${i + 1}] ${r.title}\nURL: ${r.url}\n${r.content}`
    )
    .join("\n\n---\n\n");
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

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
// parseToolArgs
// ---------------------------------------------------------------------------

function parseToolArgs(raw: string): Record<string, string> {
  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// The research agent loop
//
// Identical loop structure to 03-agent-loop. The model:
//   1. Decides what to search for
//   2. Reads results
//   3. Decides if it needs more searches or is ready to answer
//   4. Calls write_answer — loop exits
//
// Two failure modes this loop defends against:
//   1. Search spiral — model keeps searching and never answers (MAX_ITERATIONS)
//   2. Hallucinated citations — model invents URLs it never actually visited.
//      The system prompt explicitly forbids citing URLs not in search results.
//      This doesn't eliminate hallucination but it reduces it significantly.
//
// Typical iteration flow:
//   iteration 1: → web_search("...")        ← 5 results
//   iteration 2: → web_search("...")        ← 5 more results (follow-up query)
//   iteration 3: → write_answer("...")      ← done
// ---------------------------------------------------------------------------

async function runResearchAgent(question: string): Promise<string> {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    {
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
          // Model hallucinated a tool name — return a clear error so it recovers.
          messages.push({ role: "tool", tool_call_id: call.id, content: `Unknown tool: "${call.function.name}"` });
        }
      }

      console.log();
    }
  }
}

// ---------------------------------------------------------------------------
// Demo
// ---------------------------------------------------------------------------

async function main() {
  const answer = await runResearchAgent(
    "What are the most notable new features in Node.js 22, and is it LTS yet?"
  );

  console.log("─".repeat(60));
  console.log("\nAnswer:\n");
  console.log(answer);
}

main().catch(console.error);
