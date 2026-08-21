// ============================================================
//  第一课补充：error-handling-retries（错误处理与重试）
//
//  🏠 生活化比喻：
//  - 临时错误（429 限流 / 5xx / 超时）= 「对方占线，稍后再拨」——
//    过一会儿再打可能就通了
//  - 永久错误（401 key 错 / 400 参数错）= 「空号」——
//    再拨一百次也是空号，重试毫无意义
//  - 指数退避 = 「每次敲门比上次多等一会儿，别把门敲坏」
//  - jitter（随机抖动）= 「楼里所有人别在同一秒挤电梯」——
//    大量客户端整齐划一地重试，会把刚恢复的服务再次打挂
//
//  学习目标：
//  1. 区分“可以重试”的临时错误和“不该重试”的永久错误
//  2. 理解指数退避 backoff 与 jitter 的作用
//  3. 学会在模型调用外包一层可靠性逻辑
//
//  Agent 系统不是只写 prompt。真实环境里会遇到限流、超时、上游故障、
//  认证失败等问题。可靠性代码决定系统能不能长期稳定运行。
// ============================================================

import "dotenv/config";
import OpenAI from "openai";
import client from "./src/openai-charles-client";

// const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

type ApiLikeError = {
  status?: number;
  message?: string;
};
// 这里定义一个简化版错误类型。不同 SDK 的错误对象形状可能不同，
// 但通常都会包含 HTTP status 或 message。

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
  // 把 setTimeout 包成 Promise 后，就可以用 await wait(ms)。
}

function isRetryable(error: ApiLikeError) {
  return error.status === 429 || (error.status !== undefined && error.status >= 500);
  // 429：限流，等一会儿可能恢复。
  // 5xx：服务端临时错误，重试可能成功。
  // 400/401 这类通常是请求或认证问题，重试同样的请求没有意义。
  //
  // ⚠️ 把 401/400 放进重试 = 白白烧配额、白等几轮退避——
  // 认证和参数问题要修代码/配置，不是「再试一次」能解决的。
}

function errorType(error: ApiLikeError) {
  if (error.status === 429) return "请求限流";
  if (error.status !== undefined && error.status >= 500) return "服务器错误";
  if (error.status === 400) return "错误请求";
  if (error.status === 401) return "认证错误";
  return "未知错误";
}

function backoffWithJitter(attempt: number) {
  const baseDelayMs = 1000;
  const jitterMs = Math.floor(Math.random() * 250);

  return baseDelayMs * 2 ** (attempt - 1) + jitterMs;
  // 指数退避：第 1 次等约 1s，第 2 次等约 2s，第 3 次等约 4s。
  // jitter 是随机抖动，避免大量请求在同一时间整齐地重试，造成二次拥堵。
  //
  // 📤 时间线走查（真实参数：base 1000ms，jitter 0–249ms，最多 4 次）：
  //   请求 → 429 → 等约 1.0–1.25s → 重试
  //        → 500 → 等约 2.0–2.25s → 重试
  //        → 成功（前两次失败是代码故意模拟的，见下方 try 块）
  //   若一路失败到第 4 次：错误原样抛出，不再等待。
  //   对比：如果第一次就撞上 401（空号），立刻 throw，
  //   一毫秒都不多等——这就是「占线」和「空号」的待遇差别。
}

async function callWithRetries(prompt: string) {
  const maxAttempts = 4;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // for 循环把“最多尝试几次”写得很明确。
    // 每轮要么成功 return，要么遇到错误后判断是否继续。
    // 前两次的失败是「演」出来的：attempt 1 强制 429、attempt 2 强制 500，
    // 保证任何环境下都能看到完整的重试日志，之后才发真实请求。
    try {
      // Attempt 1 is intentionally simulated so this example always shows a 429 retry.
      if (attempt === 1) {
        throw { status: 429, message: "Simulated rate limit" };
      }

      // Attempt 2 is intentionally simulated so this example always shows a 500 retry.
      if (attempt === 2) {
        throw { status: 500, message: "Simulated transient server error" };
      }

      console.log(`尝试次数=${attempt}，正在发送请求`);

      const response = await client.chat.completions.create({
        model: model,
        max_tokens: 500,
        messages: [{ role: "user", content: prompt }],
      });

      return response.choices[0].message.content ?? "";
    } catch (error) {
      const apiError = error as ApiLikeError;
      const retryable = isRetryable(apiError);
      const waitMs = backoffWithJitter(attempt);
      // catch 里不要只 console.error。要把错误归类、记录，并决定下一步。

      console.log(
        `尝试次数=${attempt} 错误类型=${errorType(apiError)} 状态码=${apiError.status ?? "无"} 可重试=${retryable ? "是" : "否"} 等待毫秒数=${retryable && attempt < maxAttempts ? waitMs : 0}`
      );

      if (!retryable || attempt === maxAttempts) {
        throw error;
        // 不可重试，或者次数用完，就把错误抛给调用方。
        // 吞掉错误会让外层误以为请求成功了。
      }

      await wait(waitMs);
    }
  }

  throw new Error("Retry loop ended without a response.");
}

async function main() {
  // 这个例子前两次故意失败，所以运行时一定能看到 retry 日志。
  const result = await callWithRetries(
    "请用两句话向后端工程师解释指数退避。"
  );

  console.log("\n最终结果：");
  console.log(result);
}

main().catch(console.error);
