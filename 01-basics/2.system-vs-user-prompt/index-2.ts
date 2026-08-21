
// ============================================================
//  第二课练习版：system-vs-user-prompt（index-2）
//
//  🏠 生活化比喻：
//  如果 index.ts 是「带四个对照组的正式实验」，
//  这个文件就是「实验开始前擦桌子的那块抹布」——
//  只做一件事：把一个最普通的 OpenAI 客户端搭起来，确认配置读得到。
//
//  它和 index.ts 的关系（一句话）：
//  index.ts 跑完整的 system/user prompt 对比实验，且它的 client 来自
//  ./src/openai-charles-client.ts（设 USE_CHARLES=1 可走代理抓包）；
//  本文件则直接 new OpenAI(...) 造一个普通客户端，不走任何代理。
//
//  学习目标：
//  1. 复习 dotenv/config 的最简加载方式
//  2. 看懂创建 OpenAI 客户端需要哪些配置
//  3. 为本课其他实验准备一个最小客户端草稿
//
//  核心结论：
//  创建客户端只是「登记」，不会发出任何网络请求；本文件也没有一行
//  代码真正去调 create()——所以 .env 配置齐全时直接跑它，终端毫无输出。
//  （前提：.env 写了 OPENAI_API_KEY。若缺失，openai SDK v4 会在
//    new OpenAI(...) 这一步就抛错红字退出，详见下方走查。）
// ============================================================

import "dotenv/config"
// 副作用导入：把 .env 里的变量加载进 process.env。
// 更详细的展开（含 override、终端变量优先级）见同目录 index.ts 第一部分。

import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL
})
// 📤 输入输出走查（这个文件运行时的两种结局）：
//   .env 写了 OPENAI_API_KEY=sk-xxx（OPENAI_BASE_URL 可选）
//   → 值进入 process.env → client 把它们记在身上备用
//   → 到此为止。没有请求发出，终端也没有任何输出
//   .env 没写 OPENAI_API_KEY（环境变量也没有）
//   → new OpenAI(...) 构造阶段就抛 OpenAIError 红字退出：
//     "The OPENAI_API_KEY environment variable is missing or empty; ..."
//   （openai SDK v4 起构造时就检查 Key，不用等到真正调用 API）
//
// client 当前没有被导出或调用，像是课堂中临时验证环境变量的草稿。
// 保留它可以作为“最小客户端创建示例”参考。
