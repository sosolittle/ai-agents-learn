# Error Handling Retries

Retry logic helps an LLM call recover from temporary failures without hiding real bugs or retrying unsafe requests forever.

---

## What this demonstrates

- Simulating a 429 rate limit and a 500 server error
- Retrying only retryable failures
- Using exponential backoff with jitter
- Logging attempt number, error type, status, retryability, and wait time
- Stopping after a readable max attempt count

---

## Why this matters

Agents often make many LLM and tool calls. Without a retry policy, one temporary API failure can break an entire multi-step run. With a sloppy retry policy, the system can waste money, worsen rate limits, or hide the real error.

This example intentionally simulates 429 and 500 errors so you can see the retry path without waiting for real API failures.

---

## Run it

```bash
cp .env.example .env
# add your OPENAI_API_KEY to .env

npm install
npm start
```

---

## Expected output

```text
attempt=1 error_type=rate_limit status=429 retryable=true wait_ms=1137
attempt=2 error_type=server_error status=500 retryable=true wait_ms=2094
attempt=3 sending request

Final result:
Exponential backoff is...
```

---

## The code, explained

The example treats 429 and 5xx errors as retryable:

```ts
return error.status === 429 || error.status >= 500;
```

It waits longer after each failure and adds jitter:

```ts
baseDelayMs * 2 ** (attempt - 1) + jitterMs
```

Jitter prevents every retrying worker from waking up at the exact same time.

---

## The key insight

Retry the errors that might recover. Fail fast on errors that need a code, auth, or input fix.

---

## What can go wrong

- Retrying 401 or 400 forever wastes money.
- Retrying instantly can worsen rate limits.
- Hiding final errors makes debugging harder.
- No max attempts can create infinite loops.

---

## Where this shows up in agents

Agents often make many LLM/tool calls. Without retry policy, a temporary API failure can break an entire multi-step run.

---

## Production upgrades

- Add jitter, as shown here.
- Add a request timeout.
- Log request IDs for correlation.
- Set a max total retry time.
- Return a fallback response when appropriate.
- Alert after repeated failures.

---

## Try it yourself

- Change the simulated first error to `401` and confirm it does not retry.
- Increase `maxAttempts` to 5 and inspect the wait times.
- Change jitter from `250` to `1000` and see how the logs differ.
