# 结构化输出

结构化输出会把模型生成的文本，转换成应用代码可以解析、校验，并传给下一步使用的可预测数据。

---

## 这个示例演示什么

- 使用 tool/function calling 要求模型返回指定的数据形状
- 定义字段、可为空的值，以及枚举值
- 把函数调用参数解析成 JSON
- 生成可以继续交给下游代码使用的数据

---

## 为什么这很重要

当某一步模型输出要交给应用代码继续处理时，结构化输出非常关键。UI 展示、数据库写入、工作流分支或工具调用，需要的是更可信的字段，而不是一段“看起来像对的”文字。

---

## 运行方式

```bash
cp .env.example .env
# 在 .env 里填入你的 OPENAI_API_KEY

npm install
npm start
```

如果使用讯飞星火 Coding Plan 的 OpenAI 兼容接口，这个示例调用的是
`client.chat.completions.create`，所以 `.env` 中要使用 Chat Completions 地址：

```bash
OPENAI_BASE_URL=https://maas-coding-api.cn-huabei-1.xf-yun.com/v2
OPENAI_MODEL=astron-code-latest
```

讯飞文档里 `https://maas-coding-api.cn-huabei-1.xf-yun.com/v1` 是给 Codex
Responses wire API 使用的地址；直接用于这个 Chat Completions 示例会得到 404。

---

## 预期输出

```text
提取结果：
{
  "job_title": "高级全栈工程师",
  "company": "Acme Corp",
  "location": "伦敦",
  "salary_range": { "min": 85000, "max": 110000, "currency": "GBP" },
  "required_skills": ["React", "Node.js", "PostgreSQL", "TypeScript"],
  "seniority_level": "senior"
}
```

---

## 代码说明

代码会强制模型调用一个指定名称的函数：

```ts
tools: [{ type: "function", function: { name: "extract_job_posting", parameters: { ... } } }],
tool_choice: { type: "function", function: { name: "extract_job_posting" } },
```

返回的 arguments 是一个 JSON 字符串。schema 会约束输出形状，而好的 schema 设计也是提示词设计的一部分：清楚的字段名、合理的枚举值、明确标出哪些字段可以为空，都能提升可靠性。

---

## 关键理解

当模型输出要变成程序输入时，应该设计一个明确的数据契约，而不是期待自由文本刚好可以被解析。

---

## 可能出错的地方

- `JSON.parse` 返回的仍然是没有经过类型校验的数据。
- schema 字段可能写得太模糊。
- 如果可为空字段设计不好，模型可能会编造不存在的信息。
- 枚举值通常仍然需要在你自己的代码里再校验一次。

---

## 在 agent 中的常见使用场景

agent 会在这些地方使用结构化输出：路由决策、工具参数、信息抽取结果、工作流状态、评估分数，以及模型步骤之间的交接。

---

## 你可以自己试试

- 给 `seniority_level` 添加一个新的枚举值。
- 把 `salary_range` 改成必填，然后用一段没有薪资信息的职位描述测试。
- 在 `JSON.parse` 之后添加一个输出校验器。
