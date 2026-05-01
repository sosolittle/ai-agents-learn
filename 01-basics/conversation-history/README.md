# Conversation History

Multi-turn conversation is just a growing `messages` array that you send back to the model on every request.

---

## What this demonstrates

- Maintaining conversation history in application code
- Appending each user message before the API call
- Appending each assistant response after the API call
- Running a simple hardcoded 3-turn conversation

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
User:
What is an AI agent?

Messages sent to the API:
system -> user

Assistant:
An AI agent is...

Messages after appending assistant response:
system -> user -> assistant
```

---

## The key insight

The API does not remember your previous request. There is no hidden server-side conversation state.

This array is the memory:

```ts
messages.push({ role: "user", content: userTurn });
const response = await client.chat.completions.create({ messages, ... });
messages.push({ role: "assistant", content: assistantReply });
```

If you leave an earlier turn out of `messages`, the model cannot use it. If you want the conversation to continue tomorrow, you need to store the messages yourself and send the relevant history again.
