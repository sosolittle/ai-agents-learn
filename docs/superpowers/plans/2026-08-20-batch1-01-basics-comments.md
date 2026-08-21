# 批次 1：01-basics 注释通俗化升级 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 把 01-basics 的 11 个子文件夹、33 个 TS 文件的注释升级为初学者友好的三层结构（🏠 比喻 / 📤 输入输出走查 / ⚠️ 易错点），代码逻辑零改动。

**Architecture:** 每个子文件夹一个任务（天然的评审单元），任务内先跑 typecheck 基线、再改注释、再复跑 typecheck、再做 diff 审计。批次末尾统一审计并请用户验收。后续批次 2–6（02+03 / 04+05 / 06+07 / 08+09+10 / 11+12）在批次 1 验收后另写计划。

**Tech Stack:** TypeScript (CommonJS + ts-node)，OpenAI / Anthropic SDK。无新依赖。

**设计文档：** `docs/superpowers/specs/2026-08-20-beginner-friendly-comments-design.md`（含风格示例附录，执行前必读）

## Global Constraints

- **代码逻辑一行不改**：只允许增、删、改「注释行」和空行。绝不修改任何可执行代码、字符串内容、prompt 文本（模板字符串里的 prompt 是程序功能的一部分！）、import、类型定义。
- **绝不删除**：被注释掉的代码、`index-2.ts` / `index2.ts` / `index_original.ts` / `index副本.ts` / `index_en.ts` / `index_2.ts` 等变体文件本身（CLAUDE.md 要求保留；本任务给它们加注释而不是清理）。
- 不动：`README.md`、`.env.example`、`package.json`、`package-lock.json`、`tsconfig.json`、`data/`。
- 注释语言：中文。三层结构：文件头（🏠 比喻开场 + 学习目标 + 核心结论，`====` 包围）/ 段落级 / 关键行 📤 走查。⚠️ 仅在高危易错点偶尔使用。
- 比喻只在概念首次出现时展开，复用时一句话带过。
- 每个子文件夹注释改完后 `npx tsc --noEmit` 必须与基线一致（2026-08-20 基线：**11 个子文件夹全部 0 错误**；注意本机 npm 会打 info 日志，判断标准是 exit code 和有无 `error TS` 行）。
- 本批次**一个 commit**（Task 12），提交前先问用户（用户此前明确拒绝过自动 git commit，2026-08-20）。

## Diff 审计命令（每个任务第 5 步通用）

```bash
cd /Users/scxys/Desktop/ai-agents-learn
git diff -U0 -- "01-basics/<子文件夹>" \
  | grep -E '^[-+]' | grep -vE '^(\+\+\+|---)' \
  | grep -vE '^[-+]\s*(//|/\*|\*)' | grep -vE '^[-+]\s*$'
```

**期望输出：空。** 该命令列出所有「非注释、非空行」的增删行——只要有输出就说明改到了代码，必须立即修复。若模板字符串内的行被误报，说明改到了字符串内容，同样必须回滚该处修改。

## Typecheck 命令（每个任务通用）

```bash
cd /Users/scxys/Desktop/ai-agents-learn/01-basics/<子文件夹> && npx tsc --noEmit; echo "exit: $?"
```

期望 `exit: 0` 且无 `error TS` 行（npm 的 info 日志可忽略）。

---

### Task 1: 1.simple-llm-call（首次 LLM 调用）

**Files:**
- Modify: `01-basics/1.simple-llm-call/index.ts`（812 行，已有 494 行中文注释——本仓库注释最密的文件，做**轻量升级**）
- Modify: `01-basics/1.simple-llm-call/index-2.ts`（147 行，注释较浅——**加深度**）

**Interfaces:**
- Consumes: 设计文档风格示例（三层结构、emoji 标记）。
- Produces: 无下游依赖（各任务独立）。

**内容方向（比喻与走查素材）：**
- 主比喻沿用文件已有的「最小组成单元」叙事，检查并补齐：SDK = 「官方电话总机」，`messages` 数组 = 「通话前递给模型的便签」，`role: "system"|"user"|"assistant"` = 「便签上的三种落款」。
- `async/await`：🏠 像点外卖——下单后不用站在门口等，骑手到了（Promise resolve）再继续；此处为前端初学者补一句与 `fetch` 的类比。
- index.ts 轻量升级要点：通读现有注释，把晦涩句子通俗化；确保至少每个大段有 1 个 📤；⚠️ 提示 API key 泄露/计费。
- 📤 走查素材（必须包含一个完整 JSON 形状示例）：`client.chat.completions.create({ model, messages: [{ role: "user", content: "你好" }] })` → 返回 `choices[0].message.content`，展示真实的响应 JSON 结构（读文件里的实际打印代码取真实字段名）。
- index-2.ts：读完后在头部注明它与 index.ts 的关系（变体/练习），再按三层结构补段落级注释。

- [x] **Step 1: typecheck 基线** — 运行 Typecheck 命令，确认 exit 0
- [x] **Step 2: 通读两个文件**，列出拟改注释点
- [x] **Step 3: 逐段升级注释**（index.ts 轻量、index-2.ts 加深度）
- [x] **Step 4: 复跑 typecheck** — exit 0
- [x] **Step 5: diff 审计** — 审计命令输出为空

### Task 2: 2.system-vs-user-prompt（system 与 user 提示词）+ 标准客户端注释定稿

**Files:**
- Modify: `01-basics/2.system-vs-user-prompt/index.ts`（551 行，303 行中文注释——**轻量升级**）
- Modify: `01-basics/2.system-vs-user-prompt/index-2.ts`（22 行——**加头注**）
- Modify: `01-basics/2.system-vs-user-prompt/test-charles.ts`（35 行——**加头注**）
- Modify: `01-basics/2.system-vs-user-prompt/src/openai-charles-client.ts`（55 行——**标准客户端注释在此定稿**，后续 8 个副本复用）

**Interfaces:**
- Produces: **标准客户端注释模板**（本任务 Step 3 定稿），Task 3–11 的 `src/openai-charles-client.ts` 副本直接套用。

**内容方向：**
- 🏠 system prompt = 「岗位说明书（JD）」，进公司就生效、全程不变；user prompt = 「客户当场提出的问题」。对比走查：同一句用户提问，换不同 system 后回答口吻/内容如何变（用文件里真实的两组 system 文本举例）。
- index-2.ts / test-charles.ts 头注：一句话说明用途与和 index.ts 的关系。
- 客户端注释定稿（保留现有头注骨架，正文段落级补齐）：🏠 它是「给 SDK 换一部带监听的电话」——不改变打给谁（API 端点），只是让 Charles 能「旁听」；`USE_CHARLES=1` 环境变量 = 监听开关；`ProxyAgent` = 「总机转接」；自定义 `fetch` = SDK 允许你换掉「送信员」。⚠️ 平时不开代理，否则所有请求都发往 127.0.0.1:8888 导致报错。

- [x] **Step 1: typecheck 基线** — exit 0
- [x] **Step 2: 通读 4 个文件**
- [x] **Step 3: 升级 index.ts + 两个小文件头注 + 定稿客户端注释模板**
- [x] **Step 4: 复跑 typecheck** — exit 0
- [x] **Step 5: diff 审计** — 输出为空

### Task 3: 3.temperature-and-tokens（温度与 token 限制）

**Files:**
- Modify: `01-basics/3.temperature-and-tokens/index.ts`（90 行，仅 23 行注释——**加深度，本任务为「薄文件加深度」的参考样板**）
- Modify: `01-basics/3.temperature-and-tokens/src/openai-charles-client.ts`（55 行——套用 Task 2 定稿的模板，下同）

**内容方向：**
- 🏠 temperature = 「骰子的面数」：temp→0 是两面骰（几乎总选最稳的词），temp 高是百面骰（冷门词也有机会）；或「标准配方 vs 即兴调酒」。`max_tokens` = 「便签纸只有这么大，写满了就得停」。
- 📤：同一个 prompt（取文件里真实的），temp=0 连跑 3 次输出几乎一致；temp=1.5 三次各不相同——用小表格写在注释里。token 走查：`usage.prompt_tokens / completion_tokens / total_tokens` = 「账单小票」，代入文件里真实数字算一次钱。
- ⚠️：temperature 不改变模型「知识」，只改变「选词的保守程度」。

- [x] **Step 1: typecheck 基线** — exit 0
- [x] **Step 2: 通读 2 个文件**
- [x] **Step 3: 加深度注释 + 套用客户端模板**
- [x] **Step 4: 复跑 typecheck** — exit 0
- [x] **Step 5: diff 审计** — 输出为空

### Task 4: 4.prompt-templates（提示词模板）

**Files:**
- Modify: `01-basics/4.prompt-templates/index.ts`（99 行——**加深度**）
- Modify: `01-basics/4.prompt-templates/src/openai-charles-client.ts`（套用模板）

**内容方向：**
- 🏠 模板 = 「合同模板/申请表」：固定条款印好，空位（变量）填入；随手拼字符串 = 每次手写整份合同。fenced code block（\`\`\` 包裹用户代码）= 「快递箱里再套一层防撕袋」：模型一眼就知道袋里是「要处理的原材料」而不是「给你的指令」，防止用户代码里混入 "ignore previous instructions" 之类内容改变模型行为。
- 📤：展示同一用户输入在「随手拼」vs「模板」两种 prompt 下的成品字符串对比（用文件里真实模板函数）。

- [x] **Step 1–5:** 同 Task 3 流程。

### Task 5: 5.few-shot-prompting（少样本提示）

**Files:**
- Modify: `01-basics/5.few-shot-prompting/index.ts`（129 行——**加深度**）
- Modify: `01-basics/5.few-shot-prompting/src/openai-charles-client.ts`（套用模板）

**内容方向：**
- 🏠 zero-shot = 「只给新员工一页规章制度」；few-shot = 「再给他看 3 个老员工处理过的真实案例」——案例比规则更容易模仿。
- 📤：取文件里真实的分类示例，走查 "Can I get a refund for order ORD-002?" → 模型看示例后输出 `billing` 分类；低 temperature 在这里的作用 = 「分类任务要的是法官，不是诗人」。

- [x] **Step 1–5:** 同 Task 3 流程。

### Task 6: 6.structured-output（结构化输出）——本任务文件最多

**Files:**
- Modify: `01-basics/6.structured-output/index.ts`（157 行——**加深度**）
- Modify: `01-basics/6.structured-output/index2.ts`（4 行空壳——**加 1–2 行头注说明用途**，不添加其他内容）
- Modify: `01-basics/6.structured-output/index副本.ts`（130 行——头注说明与 index.ts 的关系 + 段落级）
- Modify: `01-basics/6.structured-output/src/openai-charles-client.ts`（74 行，比标准副本长——套模板后为多出的部分单独补注）
- Modify: `01-basics/6.structured-output/src/openai-charles-client.test.ts`（17 行，零注释——加头注说明测试意图）

**内容方向：**
- 🏠 自由文本 = 「收到一封手写信，人眼才能读」；JSON = 「收到一张填好的表格，程序直接取第 3 列」。JSON Schema = 「表格的表头规定」；TS interface ↔ JSON Schema = 「同一张表格的两种描述语言」。
- 📤：模型按 schema 吐出 `{ name: "Wireless Headphones", price: 99 }` → 代码里 `JSON.parse` 后 `response.name` 直接可用；对比自由文本要先正则/再解析。
- ⚠️：模型偶尔会输出带 \`\`\`json 围栏或前后废话的字符串，parse 前要清洗（若文件里没有此处理，就写「这里没有处理，是个已知薄弱点」的观察注释，不添加代码）。

- [x] **Step 1–5:** 同 Task 3 流程（typecheck 注意：src 下文件经由 import 被检查）。

### Task 7: 7.input-output-validation（输入/输出校验）——含唯一零注释文件

**Files:**
- Modify: `01-basics/7.input-output-validation/index.ts`（235 行——**加深度**）
- Modify: `01-basics/7.input-output-validation/index_en.ts`（176 行——通读后头注说明它与 index.ts 的关系，正文按需段落级）
- Modify: `01-basics/7.input-output-validation/index_2.ts`（111 行，**零注释——从零写三层注释**）
- Modify: `01-basics/7.input-output-validation/src/openai-charles-client.ts`（套用模板）

**内容方向：**
- 🏠 Zod = 「小区门禁闸机」：访客（输入）要先刷证（schema.parse），不符合直接拦下并告诉你哪里不对；模型输出 = 「快递也要开箱验货」——模型是「生成文本的」，它吐的 JSON 可能缺字段、多个引号，parse + 校验后才能用。
- 📤：`"ORD-00"`（格式错）→ `z.object(...).safeParse` 返回 `success: false, error.issues[0].message`；超长输入被长度校验拦截的例子（用文件里真实的 schema 字段）。
- ⚠️：`parse` 抛异常 vs `safeParse` 返回结果的差别（若两种都在文件中出现，注释点明选型理由；只出现一种则对比说明另一种）。

- [x] **Step 1–5:** 同 Task 3 流程。

### Task 8: 8.conversation-history（多轮对话历史）

**Files:**
- Modify: `01-basics/8.conversation-history/index.ts`（75 行——**加深度**）
- Modify: `01-basics/8.conversation-history/index_original.ts`（71 行——头注说明与 index.ts 关系 + 段落级）
- Modify: `01-basics/8.conversation-history/src/openai-charles-client.ts`（套用模板）

**内容方向：**
- 🏠 模型 = 「每次都是新上岗的客服」，没有上一通电话的记忆；`messages` 数组 = 「每次通话前把完整聊天记录打印出来递给客服」。所以记忆不是模型的能力，是**应用代码每次重发历史**实现的。
- 📤：走查第二轮对话时 messages 的完整内容：`[user: 第一个问题, assistant: 第一个回答, user: 第二个问题]`——少了中间那条 assistant，模型就「失忆」了。

- [x] **Step 1–5:** 同 Task 3 流程。

### Task 9: 9.prompt-chaining（提示词链）

**Files:**
- Modify: `01-basics/9.prompt-chaining/index.ts`（63 行——**加深度**）
- Modify: `01-basics/9.prompt-chaining/index_original.ts`（60 行——头注说明关系 + 段落级）
- Modify: `01-basics/9.prompt-chaining/src/openai-charles-client.ts`（套用模板）

**内容方向：**
- 🏠 大任务拆链 = 「做菜分步：买菜→洗→切→炒」，每步只干一件事、都可单独检查；前一步输出 = 下一步食材——食材坏了（前步出错）后面菜必然错（链式风险）。
- 📤：用文件里真实链路走查：步骤 1 输出 `"...大纲..."` → 作为步骤 2 prompt 的 `{outline}` 变量 → 步骤 2 输出正文；标注若步骤 1 返回空字符串会发生什么。

- [x] **Step 1–5:** 同 Task 3 流程。

### Task 10: 10.error-handling-retries（错误处理与重试）

**Files:**
- Modify: `01-basics/10.error-handling-retries/index.ts`（116 行——**加深度**）
- Modify: `01-basics/10.error-handling-retries/index_original.ts`（113 行——头注说明关系 + 段落级）
- Modify: `01-basics/10.error-handling-retries/src/openai-charles-client.ts`（套用模板）

**内容方向：**
- 🏠 临时错误（429/5xx/超时）= 「对方占线，稍后再拨」；永久错误（401 key 错/400 参数错）= 「空号，再拨一百次也是空号」。指数退避 = 「每次敲门比上次多等一会儿，别把门敲坏」；jitter = 「楼里所有人别在同一秒挤电梯」。
- 📤：时间线走查 `429 → 等 1s 重试 → 又 429 → 等 2s → 又 429 → 等 4s → 成功`（用文件里真实的退避参数）；401 时立即放弃的时间线对比。
- ⚠️：重试只对临时错误，把 401 放进重试 = 白白烧配额。

- [x] **Step 1–5:** 同 Task 3 流程。

### Task 11: 11.streaming（流式输出）

**Files:**
- Modify: `01-basics/11.streaming/index.ts`（517 行，294 行中文注释——**轻量升级**，同 Task 1 的 index.ts 处理方式）
- Modify: `01-basics/11.streaming/index-2.ts`（122 行——**加深度**）
- Modify: `01-basics/11.streaming/src/openai-charles-client.ts`（套用模板）

**内容方向：**
- 🏠 普通响应 = 「等对方把整封信写完才寄出」；streaming = 「写一句传真一句」，用户第 1 秒就能看到第一个字。chunk = 「传真的每一页纸」，拼接 `content` = 「把每页按顺序贴成长卷轴」。
- 📤：走查 3 个真实 chunk 的 JSON 形状（读文件取真实字段，如 `choices[0].delta.content`）→ 拼接过程 → 最终完整文本；对比非流式一次性返回的 JSON。
- ⚠️：`finish_reason` / 结束信号判断（用文件里真实写法）。

- [x] **Step 1–5:** 同 Task 3 流程。

### Task 12: 批次审计、汇报、提交

**Files:**
- 无新修改；产出批次审计结果与验收说明。

- [x] **Step 1: 全量 typecheck** — 对 11 个子文件夹逐一运行 Typecheck 命令，全部 exit 0
- [x] **Step 2: 全量 diff 审计** — 对 `01-basics/` 整体运行 Diff 审计命令，输出为空
- [x] **Step 3: 生成批次摘要** — 列出每个文件的修改行数（`git diff --stat -- 01-basics/`）、每个子文件夹补的比喻/走查主题，交给用户抽查
- [x] **Step 4: 请求用户验收** — 用户抽查若干文件；有意见→逐条修改后重跑 Step 1–2；通过→询问是否由我提交 commit（建议消息：`优化 01-basics 注释：通俗比喻 + 输入输出走查`），或用户自行提交
- [x] **Step 5: 验收通过后** — 与用户确认批次 2（02+03）是否开始；批次 2 计划届时另写

## Self-Review 记录

- **Spec 覆盖**：三层结构✓（各任务 Step 3）、emoji 标记✓、深度梯度✓（01 最细：薄文件加深度、密文件轻量升级）、比喻+走查两种举例✓（每任务给了具体素材）、保护约束✓（Global Constraints）、typecheck 验证✓、批次暂停验收✓（Task 12 Step 4）、批次 2–6 另写计划✓（Architecture 段说明）。
- **占位符扫描**：无 TBD/TODO；「内容方向」给出了可直接落笔的比喻文案与走查数据。
- **一致性**：客户端注释模板在 Task 2 定稿、Task 3–11 引用为「套用 Task 2 定稿的模板」——指代明确；Typecheck/Diff 审计命令全文唯一定义在 Global Constraints 区，任务内引用。
