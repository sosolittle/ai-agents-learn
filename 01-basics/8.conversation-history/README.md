# Conversation History

Conversation history is a `messages` array that your application sends back to the model on each turn so the model can use prior context.

---

## What this demonstrates

- Maintaining conversation history in application code
- Appending each user message before the API call
- Appending each assistant response after the API call
- Running a simple hardcoded three-turn conversation

---

## Why this matters

The API does not remember previous requests for you. If an assistant should respond with context, your application must decide which past messages to include, how much history is worth paying for, and when history needs trimming or summarization.

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

## The code, explained

The array is the conversation state:

```ts
messages.push({ role: "user", content: userTurn });
const response = await client.chat.completions.create({ messages, ... });
messages.push({ role: "assistant", content: assistantReply });
```

If a message is missing from the array, the model cannot use it. If you want the conversation to continue later, you need to store the relevant messages yourself.

---

## The key insight

Context is not free memory. History grows, costs tokens, and eventually needs selection, trimming, or summarization.

---

## What can go wrong

- Sending the full history forever increases cost and latency.
- Dropping important turns can make the assistant forget key facts.
- Old user instructions can conflict with new goals.
- Sensitive information can accidentally be resent in later calls.

---

## Where this shows up in agents

Agents use conversation history for chat continuity, task state, previous tool results, planner notes, and summaries of prior steps.

---

## Try it yourself

- Remove the first user turn and see how the later answer changes.
- Add a fourth turn that depends on earlier context.
- Print token usage as the conversation grows.
