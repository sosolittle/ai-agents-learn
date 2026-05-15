# LinkedIn Post Notes — Scrape Page Agent

## Core angle

Search gives an agent candidate sources. Scraping lets it inspect one source deeply. The important engineering lesson is that giving an agent a browser-like tool requires safety boundaries: it should not be able to fetch arbitrary URLs just because the model asked.

## Hook options

1. "Search is not reading. It is source discovery."
2. "A research agent needs two skills: find pages, then inspect the right one."
3. "The dangerous part of agent tools is not the API call. It is what the model is allowed to call."
4. "If your agent can scrape any URL, you have not built a research assistant — you have built an uncontrolled fetch box."
5. "Tool safety should be enforced in code, not trusted to the prompt."

## Main teaching points

- web_search gives snippets, not full evidence
- scrape_page turns one result into source material
- the model chooses when to scrape
- scraped content must be bounded before entering context
- URL allowlists prevent arbitrary fetches
- private/internal URLs should be blocked
- redirects should not bypass URL validation
- production crawlers need stronger controls

## Code snippet to feature

```ts
const allowedScrapeUrls = new Set<string>();

const normalizedRequestedUrl = normalizeUrl(args.url);

if (!normalizedRequestedUrl || !allowedScrapeUrls.has(normalizedRequestedUrl)) {
  return "Rejected: scrape_page can only fetch URLs returned by a prior web_search result.";
}
```
