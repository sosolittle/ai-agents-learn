# Streaming

Streaming lets your app receive an LLM response piece by piece as it is generated instead of waiting for the full message.

---

## What this demonstrates

- A normal non-streaming call
- A streaming call with `stream: true`
- Iterating through stream events with `for await`
- Printing partial text chunks as they arrive

---

## Why this matters

Streaming improves perceived latency. Users see the response begin quickly, even when the full answer takes longer. The tradeoff is that your code must handle partial state carefully.

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
Non-streaming call:
Waiting for the whole response...

Streaming responses let your app receive text as the model generates it...

---

Streaming call:
Printing chunks as they arrive...

Streaming responses let your app receive text as the model generates it...
```

---

## The code, explained

The streaming call returns an async iterable:

```ts
for await (const event of stream) {
  const token = event.choices[0]?.delta?.content;

  if (token) {
    process.stdout.write(token);
  }
}
```

Each event may contain a small piece of text, no text, or metadata. Your code has to assemble the final message from many chunks.

---

## The key insight

Partial tokens are not complete messages. Streaming is a state-handling problem as much as a display feature.

---

## What can go wrong

- UIs can treat partial output as final output.
- Errors can happen halfway through a stream.
- Moderation, validation, or JSON parsing cannot rely on unfinished text.
- State can get out of sync if the final message is not reconstructed.

---

## Where this shows up in agents

Agents use streaming for chat UIs, long-running reasoning displays, progress updates, and final responses where waiting for the full answer would feel slow.

---

## Try it yourself

- Add a counter for how many chunks arrived.
- Store the streamed chunks in a string and print the final message at the end.
- Try streaming a longer answer and compare perceived speed.
