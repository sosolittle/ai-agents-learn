# Scrape Page Agent

> Search gives the model excerpts. Scraping lets it read the page.

Tavily gives you excerpts. But sometimes the excerpt is only the headline and what you need is the article. This pattern adds a second tool, `scrape_page`, so the model can decide to read a full page when the search snippet is not enough.

The important part is that you still do not script the research path. The model searches, reads snippets, notices when one result looks worth opening, and asks your code to fetch that page.

---

## The mental model

`04-web-search` stopped at excerpts:

```text
search -> read excerpts -> answer
```

`05-scrape-page` adds one optional step:

```text
search -> read excerpts -> scrape full page -> answer
```

The word optional matters. The model decides when step 3 happens. If the excerpts are enough, it can answer. If one result looks promising but thin, it can call `scrape_page(url)` on that specific URL and read the extracted page text.

That is the pattern shift: search finds candidates; scraping turns one candidate into source material.

---

## Why this exists

Search results are intentionally compressed. Tavily returns useful snippets, not full documents. That is perfect for broad discovery, but weak for technical questions where the answer lives in the details:

- exact API semantics
- edge cases
- examples buried halfway through a proposal
- caveats that do not appear in the search result
- claims that need verification against the original source

The demo question asks about TC39 Temporal because the answer is not just "JavaScript gets better dates." The useful answer needs concepts like `Instant`, `PlainDate`, `ZonedDateTime`, calendar-aware arithmetic, disambiguation, and the separation between exact time and wall-clock time. A snippet can point the model at the right source. It usually cannot carry all that detail.

---

## The truncation problem

A full web page is not a clean article-shaped object. It can be 10-100k tokens of layout, navigation, examples, comments, related posts, cookie text, and duplicate content. Dumping all of that into the model context is expensive and often makes the answer worse.

This example uses an explicit cap:

```ts
const MAX_SCRAPED_CHARS = 8000;
```

The cut is intentional. You want the first 8k characters of readable text, which usually contains the title, intro, main claim, and the beginning of the substantive explanation. When the page is longer, the tool appends:

```text
[truncated - page content exceeds limit]
```

That gives the model a truthful signal: it read part of the page, not the entire thing. If it still needs more, it can search again or scrape a different URL.

In production, you might chunk the page and let the model request later chunks. For this pattern, the cap keeps the mechanism visible.

---

## The noise problem

Raw HTML to readable text is not just "strip the tags."

A typical page has navigation menus, cookie banners, footers, sidebars, script blobs, hidden elements, and repeated layout text. That noise can easily be 30-50% of the DOM. If you extract text first and clean later, the model spends attention on menus instead of meaning.

So the scraper removes common noise nodes before reading text:

```ts
root.querySelectorAll("script, style, nav, footer, header, aside, [aria-hidden='true']")
  .forEach(el => el.remove());
```

Then it asks `node-html-parser` for `structuredText`, which preserves a readable line structure better than smashing every text node into one paragraph.

This is still a simple scraper. It is not a readability engine. The goal is to make the next agent pattern obvious: one tool discovers pages, another tool opens one.

---

## Failure modes unique to scraping

Search has its own problems. Scraping adds a few more.

### Paywalls

Some pages return HTML that basically says "subscribe to continue." The request technically succeeds, but the useful content is not there. The model sees that text and should move on to another source.

### JavaScript-rendered pages

`fetch()` gets the static HTML response. If a site is rendered mostly by client-side JavaScript, the scraper may receive a nearly empty `<div id="root">` or a shell with no article content.

The fix is a headless browser such as Puppeteer or Playwright, which loads the page, runs JavaScript, and then extracts the rendered DOM. That is a separate pattern because it changes the cost, complexity, and failure modes.

### Rate limiting and bot detection

Some sites block automated requests. This example sets a browser-like `User-Agent`, which helps with basic blocks, but it does not make `fetch()` equivalent to a real browser. You should expect some URLs to fail.

The tool returns failures as plain text, not thrown exceptions, so the model can recover and choose another result.

---

## How it works

The loop is the same loop from `04-web-search`. The model receives three tools:

- `web_search` finds result snippets and URLs
- `scrape_page` fetches one URL and returns readable text
- `write_answer` ends the session

A typical run looks like this:

```text
Question: What exactly does the TC39 Temporal proposal change...

[iteration 1]
  -> web_search("TC39 Temporal proposal JavaScript dates time zones technical details")
  <- [1] Temporal | URL: https://tc39.es/proposal-temporal/...

[iteration 2]
  -> scrape_page("https://tc39.es/proposal-temporal/docs/")
  <- Temporal Documentation
     Introduction
     Temporal is a modern date/time API...

[iteration 3]
  -> write_answer (2418 chars)
```

Your code does not decide that the TC39 page should be opened. The model does. Your code only implements the tool safely enough for the model to use.

---

## What this example is / is not

**This example is:**

- a minimal research agent with both search and page scraping
- a demonstration of tool composition: discover with one tool, inspect with another
- a practical example of turning HTML into model-readable text
- a look at the new failure modes scraping introduces

**This example is not:**

- a production crawler
- a headless browser implementation
- a paywall bypass
- a complete readability extraction pipeline
- a citation validator

The goal is to show the agent pattern clearly. Production systems layer validation, chunking, robots policy, retries, and source tracking on top.

---

## Run it

```bash
cp .env.example .env
# add your OPENAI_API_KEY and TAVILY_API_KEY to .env
# get a free Tavily key at https://tavily.com

npm install
npm start
```

Do not be surprised if the exact URL the model scrapes changes between runs. That is the point of giving it tools: it chooses a path based on the live search results.

---

## References

- [Previous pattern: web search](../04-web-search/index.ts)
- [Agent loop pattern](../03-agent-loop/index.ts)
- [Tavily API docs](https://docs.tavily.com)
- [node-html-parser](https://www.npmjs.com/package/node-html-parser)
