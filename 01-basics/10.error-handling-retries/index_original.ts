// // ============================================================
// //  第一课补充：error-handling-retries（错误处理与重试）
// //
// //  学习目标：
// //  1. 区分“可以重试”的临时错误和“不该重试”的永久错误
// //  2. 理解指数退避 backoff 与 jitter 的作用
// //  3. 学会在模型调用外包一层可靠性逻辑
// //
// //  Agent 系统不是只写 prompt。真实环境里会遇到限流、超时、上游故障、
// //  认证失败等问题。可靠性代码决定系统能不能长期稳定运行。
// // ============================================================
//
// import "dotenv/config";
// import OpenAI from "openai";
//
// const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
//
// type ApiLikeError = {
//   status?: number;
//   message?: string;
// };
// // 这里定义一个简化版错误类型。不同 SDK 的错误对象形状可能不同，
// // 但通常都会包含 HTTP status 或 message。
//
// function wait(ms: number) {
//   return new Promise((resolve) => setTimeout(resolve, ms));
//   // 把 setTimeout 包成 Promise 后，就可以用 await wait(ms)。
// }
//
// function isRetryable(error: ApiLikeError) {
//   return error.status === 429 || (error.status !== undefined && error.status >= 500);
//   // 429：限流，等一会儿可能恢复。
//   // 5xx：服务端临时错误，重试可能成功。
//   // 400/401 这类通常是请求或认证问题，重试同样的请求没有意义。
// }
//
// function errorType(error: ApiLikeError) {
//   if (error.status === 429) return "rate_limit";
//   if (error.status !== undefined && error.status >= 500) return "server_error";
//   if (error.status === 400) return "bad_request";
//   if (error.status === 401) return "auth_error";
//   return "unknown_error";
// }
//
// function backoffWithJitter(attempt: number) {
//   const baseDelayMs = 1000;
//   const jitterMs = Math.floor(Math.random() * 250);
//
//   return baseDelayMs * 2 ** (attempt - 1) + jitterMs;
//   // 指数退避：第 1 次等约 1s，第 2 次等约 2s，第 3 次等约 4s。
//   // jitter 是随机抖动，避免大量请求在同一时间整齐地重试，造成二次拥堵。
// }
//
// async function callWithRetries(prompt: string) {
//   const maxAttempts = 4;
//
//   for (let attempt = 1; attempt <= maxAttempts; attempt++) {
//     // for 循环把“最多尝试几次”写得很明确。
//     // 每轮要么成功 return，要么遇到错误后判断是否继续。
//     try {
//       // Attempt 1 is intentionally simulated so this example always shows a 429 retry.
//       if (attempt === 1) {
//         throw { status: 429, message: "Simulated rate limit" };
//       }
//
//       // Attempt 2 is intentionally simulated so this example always shows a 500 retry.
//       if (attempt === 2) {
//         throw { status: 500, message: "Simulated transient server error" };
//       }
//
//       console.log(`attempt=${attempt} sending request`);
//
//       const response = await client.chat.completions.create({
//         model: "gpt-4o-mini",
//         max_tokens: 200,
//         messages: [{ role: "user", content: prompt }],
//       });
//
//       return response.choices[0].message.content ?? "";
//     } catch (error) {
//       const apiError = error as ApiLikeError;
//       const retryable = isRetryable(apiError);
//       const waitMs = backoffWithJitter(attempt);
//       // catch 里不要只 console.error。要把错误归类、记录，并决定下一步。
//
//       console.log(
//         `attempt=${attempt} error_type=${errorType(apiError)} status=${apiError.status ?? "none"} retryable=${retryable} wait_ms=${retryable && attempt < maxAttempts ? waitMs : 0}`
//       );
//
//       if (!retryable || attempt === maxAttempts) {
//         throw error;
//         // 不可重试，或者次数用完，就把错误抛给调用方。
//         // 吞掉错误会让外层误以为请求成功了。
//       }
//
//       await wait(waitMs);
//     }
//   }
//
//   throw new Error("Retry loop ended without a response.");
// }
//
// async function main() {
//   // 这个例子前两次故意失败，所以运行时一定能看到 retry 日志。
//   const result = await callWithRetries(
//     "Explain exponential backoff in two sentences for a backend engineer."
//   );
//
//   console.log("\nFinal result:");
//   console.log(result);
// }
//
// main().catch(console.error);
