# Streaming

Streaming lets you handle an LLM response as it is generated instead of waiting for the whole message to finish.

---

## What this demonstrates

- A normal non-streaming `chat.completions` call
- A streaming `chat.completions` call with `stream: true`
- Iterating over stream events with `for await`
- Printing partial tokens as they arrive

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
Non-streaming call:
Waiting for the whole response...

Streaming responses let your app receive text as the model generates it...

---

Streaming call:
Printing chunks as they arrive...

Streaming responses let your app receive text as the model generates it...
```

---

## The key insight

With a normal call, the response feels like one blob because your code only sees it after generation finishes.

With streaming, the response arrives in chunks. Each event may contain a small piece of text, no text, or metadata. That means your code has to handle partial content:

```ts
for await (const event of stream) {
  const token = event.choices[0]?.delta?.content;

  if (token) {
    process.stdout.write(token);
  }
}
```

The failure mode is assuming every event is a complete message. It is not. Your UI, CLI, or agent loop needs to build the final answer from many small pieces.
