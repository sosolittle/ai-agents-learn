# 多轮对话历史

对话历史本质上是应用代码维护的一个 `messages` 数组。每次调用 API 时，应用都会把当前问题和需要保留的历史消息一起发给模型，让模型能够参考前文。

---

## 这个示例演示什么

- 在应用代码中维护对话历史
- 调用 API 前，把当前用户消息追加到 `messages`
- 收到回答后，把 assistant 消息也追加到 `messages`
- 按顺序运行一段写死的三轮对话
- 观察每一轮发送给 API 的消息角色如何增加

---

## 为什么这很重要

Chat API 本身是无状态的：一次请求结束后，模型不会自动替你的应用记住上一轮请求。所谓“对话记忆”，通常是应用保存了历史消息，并在下一次请求时把需要的部分重新发送给模型。

这也意味着，应用必须自己决定：

- 哪些历史消息值得保留
- 每次请求要发送多少上下文
- 历史太长时要删除、筛选还是总结
- 如果稍后继续对话，要把哪些消息存到数据库

历史越长，占用的 token（模型处理文本时使用的计量单位）通常越多，请求成本和延迟也会随之增加。

---

## 运行方式

```bash
cp .env.example .env
# 在 .env 里填入你的 OPENAI_API_KEY

npm install
npm start
```

---

## 预期输出

示例使用英文问题，因此模型通常也会用英文回答。回答文字每次可能不同，重点是观察消息角色的排列。

```text
User:
What is an AI agent?

Messages sent to the API:
system -> user

Assistant:
[模型生成的两句英文解释]

Messages after appending assistant response:
system -> user -> assistant
------------------------------------------------------------

User:
How is that different from a normal chatbot?

Messages sent to the API:
system -> user -> assistant -> user

Assistant:
[模型结合上一轮上下文生成的两句英文解释]

Messages after appending assistant response:
system -> user -> assistant -> user -> assistant
------------------------------------------------------------
```

第二轮问题里的 `that` 指向上一轮谈到的 AI agent。模型之所以能理解这个指代，不是因为它自动记住了上一次调用，而是因为应用把上一轮的 user 和 assistant 消息都再次发送了。

---

## 代码说明

`messages` 数组就是这个示例的对话状态。最开始只有一条 system 消息，用来设定助手需要持续遵守的回答风格：

```ts
const messages: Message[] = [
  {
    role: "system",
    content:
      "You are a concise AI engineering tutor. Keep every answer to two sentences.",
  },
];
```

每一轮都按固定顺序更新历史：

```ts
messages.push({ role: "user", content: userTurn });

const response = await client.chat.completions.create({
  model: "gpt-4o-mini",
  max_tokens: 250,
  messages,
});

messages.push({ role: "assistant", content: assistantReply });
```

顺序很重要：

1. 先加入当前的 user 消息，模型才能看到这一轮问题。
2. 把整个 `messages` 数组发给 API，模型才能参考前文。
3. 收到回答后，再加入 assistant 消息，下一轮才能知道模型刚才回答了什么。

如果某条消息不在数组里，模型在这次请求中就看不到它。如果希望程序关闭后还能继续对话，还需要把相关消息持久化保存，而不能只放在内存变量里。

---

## 关键理解

模型的“记忆”不是免费的长期记忆，而是应用选择、保存并在后续请求中重新发送的上下文。

---

## 可能出错的地方

- 永远发送完整历史，会不断增加 token 成本和响应延迟。
- 删除了关键轮次，模型可能忘记重要事实或无法理解指代。
- 旧的用户要求可能与当前目标发生冲突。
- 敏感信息可能在后续请求中被无意地重复发送。
- 只保存 user 消息而漏掉 assistant 消息，会让对话上下文不完整。
- 多个用户共用同一个历史数组，可能造成对话串线或数据泄露。

---

## 在 agent 中的常见使用场景

agent 会用对话历史保存聊天上下文、任务状态、之前的工具结果、规划记录，以及对早期步骤的摘要。随着任务变长，agent 通常还需要主动筛选或压缩这些内容。

---

## 你可以自己试试

- 添加第四轮问题：`Can you give me one concrete example of that difference?`，观察模型如何继续引用前文。
- 暂时不把 `assistantReply` 追加到 `messages`，看看后续回答会失去哪些信息。
- 每轮打印 `messages.length`，观察三轮对话中数组长度如何从 `1` 逐步增长。
