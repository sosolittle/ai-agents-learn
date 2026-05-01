# Error Handling Retries

Production LLM calls need retry logic that knows which failures are worth retrying.

---

## What this demonstrates

- Retrying retryable failures up to three attempts
- Using exponential backoff delays of 1s, 2s, and 4s
- Treating 429 and 5xx errors as retryable
- Treating 400 and 401 errors as non-retryable
- Logging attempt number, error type, and wait time

---

## Run it

```bash
cp .env.example .env
# add your OPENAI_API_KEY to .env

npm install
npm start
```

Expected output:

```text
Attempt 1: rate limit (429)
Waiting 1s before retry...
Attempt 2: server error (500)
Waiting 2s before retry...
Attempt 3: sending request

Final result:
Exponential backoff is...
```

---

## The key insight

Not all errors are the same. A 429 means "slow down and retry." A 401 means "fix your API key," so retrying is pointless.

Naive retry-everything loops waste money and hide real configuration bugs. Backoff matters too: if you hammer a rate-limited API immediately after every failure, you can make the problem worse instead of recovering from it.
