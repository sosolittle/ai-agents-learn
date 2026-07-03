# Tool Use / Function Calling

> The first pattern that actually feels like an agent.

Before this, you were sending text in and getting text back. Tool use changes the dynamic: the LLM can now decide to call **your functions** — with its own arguments — before it gives you a final answer.

---

## Where you already see this pattern

Tool use is what makes an AI assistant useful beyond text generation. Without tools, the model can only talk. With tools, the model can act through your code.

You've already seen this pattern in tools you use every day:

- **ChatGPT searching the web** before answering a current-events question — the model calls a search tool, reads the results, then composes its reply
- **An assistant reading uploaded files** before summarising them — the file contents are fetched through a tool, not baked into the model
- **A calendar assistant checking availability** before scheduling a meeting — the model calls a calendar lookup tool rather than guessing
- **A customer support bot checking an order database** before replying — it looks up the real order status instead of making one up
- **A coding assistant reading project files** before suggesting a fix — it fetches your actual code, not an imagined version of it
- **A finance assistant using a calculator or database** before giving exact numbers — it calls a tool for precision rather than trusting its own arithmetic

What they all have in common: the model pauses mid-conversation, calls a function, waits for a real result, and then answers. That loop is what this pattern is about.

---

## The mental model

If you've built a REST API, you already understand this.

When a user hits your Express app, your router decides which handler to call based on the URL. With tool use, the **LLM is the router**. You give it a list of functions (the "tools"), and it decides which one to call, with what arguments, based on the user's message.

```
Normal flow:    you call a function → you get a result
Tool use flow:  LLM decides which function to call → you run it →
                you hand the result back → LLM uses it to reply
```

You're not in control of the routing. The model is. That's what makes it feel like an agent.

---

## How it works — the full loop

Most tutorials show you a single API call. That's not the full picture.

After you give the model tool results, it might decide it needs **more tools** before it can answer. You loop until it says it's done (`finish_reason === "stop"`).

```
You:    [system, user message]
              ↓
Model:  { tool_calls: [...] }      ← finish_reason: "tool_calls"
              ↓
You:    run each tool, collect results
              ↓
You:    [system, user, assistant(tool_calls), tool(result), ...]
              ↓
Model:  { content: "Here's your answer" }  ← finish_reason: "stop"
              ↓
Done.
```

For complex queries this can be 3 or 4 rounds. Most broken implementations handle exactly one round and wonder why the assistant sometimes gives an incomplete answer.

---

## Parallel tool calls

When two lookups are independent, the model requests them both in the **same round** — you get a `tool_calls` array with multiple entries. Run them all, send all the results back together.

```
User: "Is order ORD-001 shipped, and are the headphones back in stock?"

Model round 1:
  → get_order_status({ order_id: "ORD-001" })
  → check_inventory({ product_name: "Wireless Headphones" })
  (both in one tool_calls array)

You: run both, push both results

Model round 2: composes final reply → finish_reason: "stop"
```

The model does this automatically when it recognises the fetches don't depend on each other. Never assume `tool_calls.length === 1`.

---

## The three parts you write

### 1. Your functions (the actual logic)

Plain functions. Nothing AI-specific. In a real app these hit your database, call an internal API, read from Redis — whatever your backend already does.

```ts
function getOrderStatus(orderId: string): string {
  const order = db.orders.find(orderId);
  return JSON.stringify(order);
}
```

### 2. Tool definitions (the description you give the LLM)

JSON Schema objects that describe what each function does and what arguments it takes. The model reads these to decide which tool to call and how to fill in the params.

Two things that matter more than most developers expect:

**`description`** — this is how the model decides *when* to use the tool. Vague descriptions lead to the wrong tool being called.

```ts
// ❌ too vague — model might use this for anything order-related
description: "Gets order info"

// ✅ specific — model knows exactly when to reach for this
description: "Look up the current status of a customer order by order ID"
```

**Parameter descriptions + format hints** — this is how the model fills in the arguments. Without format hints, the model may pass `"order 1"` instead of `"ORD-001"` and your lookup silently fails.

```ts
// ❌ no format hint — model guesses the format
order_id: { type: "string", description: "The order ID" }

// ✅ format hint — model knows exactly what to pass
order_id: { type: "string", description: "The order ID, format: ORD-XXX — e.g. ORD-001" }
```

### 3. The dispatcher (your router)

A switch statement that maps tool names to function calls. This is the **security boundary** — the model cannot run code, it can only request that you run it. Auth checks, rate limiting, and input validation all go here.

```ts
function executeTool(name: string, args: Record<string, string>): string {
  switch (name) {
    case "get_order_status": return getOrderStatus(args.order_id);
    // ...
    default:
      // Always handle the unknown case.
      // The model can hallucinate a tool name that doesn't exist.
      return `Unknown tool: "${name}"`;
  }
}
```

---

## tool_choice — controlling how the model uses tools

| Value | Behaviour |
|-------|-----------|
| `"auto"` | Model decides: call a tool, call multiple, or reply directly |
| `"required"` | Model must call at least one tool |
| `"none"` | No tools — plain text response only |
| `{ type: "function", function: { name: "..." } }` | Force one specific tool (used in structured output) |

For agentic tool use, always use `"auto"`. The model is smarter than you think about deciding when tools are needed.

---

## The details most developers miss

**`arguments` is a JSON string, not an object.** Always parse it:

```ts
// The model returns this:
// { name: "get_order_status", arguments: '{"order_id":"ORD-001"}' }
//                                         ^^ this is a string

const args = JSON.parse(call.function.arguments); // ← don't forget this
```

**`tool_call_id` must match exactly.** When sending results back, the ID must match the model's request. This is how it maps results to calls when multiple tools run in one round:

```ts
messages.push({
  role: "tool",
  tool_call_id: call.id, // ← must match, not optional
  content: result,
});
```

**Always push the model's message before tool results.** The conversation history must include the assistant's tool_calls message before the tool result messages — the API enforces this order and will return a validation error if you get it wrong.

---

## What this example is / is not

**This example is:**
- a small runnable demo of function calling / tool use
- a way to understand the request → tool call → tool result → final answer loop
- intentionally built with mock data so the concept is easy to follow without any external setup

**This example is not:**
- a production customer support system
- a full agent framework
- a database, security, or auth implementation
- a replacement for input validation, permissions, or rate limiting

The goal is to make the pattern obvious. Real systems add layers on top; this example keeps the concept visible.

---

## Run it

```bash
cp .env.example .env
# add your OPENAI_API_KEY to .env

npm install
npm start
```

You'll see the model's tool requests logged as they happen:

```
User: I'm customer CUST-42. I want to reorder the Wireless Headphones. Are they in stock?

Model requested 2 tool call(s):
  → get_order_status({"order_id":"ORD-001"})
  ← {"status":"shipped","item":"Wireless Headphones","quantity":1}
  → check_inventory({"product_name":"Wireless Headphones"})
  ← {"stock":14,"sku":"WH-100"}
```

---

## Example output

Here is a realistic transcript for the query above (CUST-42 asking about Wireless Headphones):

```
User: I'm customer CUST-42. I want to reorder the Wireless Headphones from ORD-001. Are they in stock?

Model requested 2 tool call(s):
  → get_order_status({"order_id":"ORD-001"})
  ← {"status":"shipped","item":"Wireless Headphones","quantity":1}
  → check_inventory({"product_name":"Wireless Headphones"})
  ← {"stock":14,"sku":"WH-100"}

Assistant: Your order ORD-001 (Wireless Headphones) has been shipped. Good news — Wireless Headphones are currently in stock with 14 units available, so you can place a new order.
```

Your final wording may vary slightly because the model composes the final response.

---

## What's next

This pattern handles one user query at a time. The next level is the **agent loop** — where the model uses tools repeatedly over multiple steps to complete a longer task, without you driving each round manually.

That's in `03-agent-loop`.

---

## References

- [OpenAI Function Calling guide](https://platform.openai.com/docs/guides/function-calling) — official docs with more examples and edge cases
- [OpenAI tool_choice options](https://platform.openai.com/docs/api-reference/chat/create#chat-create-tool_choice) — API reference for controlling tool selection
- [JSON Schema basics](https://json-schema.org/understanding-json-schema) — understanding the parameter schema format
- [Structured output pattern](../01-basics/6.structured-output/index.ts) — how `tool_choice: "forced"` differs from `"auto"`

