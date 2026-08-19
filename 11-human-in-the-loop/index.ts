// ============================================================
//  第十一章入口：human-in-the-loop（人在回路中的审批）
//
//  学习目标：
//  1. 区分"模型有能力提出动作"和"系统允许执行动作"
//  2. 看懂 proposal → policy → approval → execution 的完整控制链
//  3. 理解高风险动作为什么必须先持久化，再由人稍后审批
//  4. 观察入口文件只负责串联流程，不把安全策略写进 prompt
//
//  核心结论：
//  Agent 只能提出建议；真正的执行权限必须由确定性代码和人类共同控制。
//
//  本文件的运行效果（npm start）：
//  打印用户请求 → 调模型拿到提案 → 策略判定 → 创建 pending 审批单
//  → 明确告知"什么都没有执行" → 提示下一步 CLI 命令。
//  整个流程在"等待人类"处干净地停下，这就是本章的"暂停"。
// ============================================================

import "dotenv/config";
// 加载 .env（唯一的模型调用需要 OPENAI_API_KEY）。
// 其余 CLI 命令不 import 本文件，也就不需要 Key。

import { proposeAction } from "./actionAgent.js";
// 模型提案（全章唯一的模型调用）。
import { handleProposal } from "./approvalService.js";
// 策略门 + 审批单生命周期编排。
import { defaultPaths } from "./config.js";
// 默认数据路径（data/ 目录下三个 JSON）。
import { prettyJson, printSection } from "./utils.js";
// 终端格式化输出。

// 固定的演示请求。它映射到一个资金动作（退款），
// 策略层把它分类为 require_approval——所以这次运行
// 提出提案然后暂停。直到有人用 CLI 批准之前，什么都不会执行。
const USER_REQUEST =
  "Refund €79.00 for order ORD-001 because the package arrived damaged.";
// 这里固定使用退款场景，是为了稳定演示 require_approval 分支。
// 如果换成查询订单状态，会进入 auto_execute；换成删除生产用户，则会进入 deny。
//
// 三个分支一次只能演示一个，选退款的理由：
//   它是三者中唯一"模型说得对、策略仍然不放行"的场景——
//   最能体现"capability 被正确执行，permission 依然缺席"。
//   查询太安全（体现不出门），删除太极端（模型都不该提议）。

async function main(): Promise<void> {
  // async：内部要 await 模型调用。
  console.log("AI Agents From Scratch — 11 Human-in-the-Loop\n");
  const paths = defaultPaths();
  // 三个 JSON store 的路径。本文件只负责演示流程，
  // 后续 CLI 命令操作的是同一批文件——跨进程接力靠的就是它们。

  printSection("User request");
  console.log(USER_REQUEST);
  // 第一步先展示"输入长什么样"。教学程序的输出顺序
  // 刻意对齐处理顺序：请求 → 提案 → 判定 → 暂停。

  // 1. 模型提出工具和参数。这是唯一的模型调用。
  //    它描述 capability——什么可能满足请求——而不是 permission。
  let proposal: Awaited<ReturnType<typeof proposeAction>>;
  // Awaited<ReturnType<T>> 的含义，从内往外读：
  //   ReturnType<typeof proposeAction> → 函数的返回类型 Promise<ActionProposal>
  //   Awaited<...>                     → 把 Promise 拆开，得到 ActionProposal
  // 等价写法是直接 import type { ActionProposal }，
  // 这里用类型运算展示"从函数签名推导类型"的技巧——
  // 当返回类型复杂或不想多 import 时很顺手。
  //
  // 为什么 let 而不是 const？因为 try/catch 里赋值：
  // try 块内 const 的作用域只在 try 里，外面拿不到。
  // "let + try 内赋值"是 TS 里"可能失败的初始化"惯用法。
  try {
    proposal = await proposeAction(USER_REQUEST);
  } catch (error) {
    // 给错误标记阶段，方便区分是模型提案失败，还是后续策略/执行失败。
    console.error({ stage: "propose", error: (error as Error).message });
    // 打印 { stage, error } 对象而不是裸消息：
    // 结构化的错误输出更容易被 grep / 日志系统解析。
    throw error;
    // 打印完再抛出：让 main 外层的 catch 统一收尾（退出码）。
    // "日志 + 重新抛出"让每一层都能留痕，最外层负责收口。
  }

  // 2. 提案已被 agent 校验过（Zod）。原样打印模型到底提出了什么——
  //    人类必须看到真实的工具和参数。
  //
  // "审批人必须看到确切参数"是 human-in-the-loop 的铁律：
  //   如果界面上只显示"模型想退款"而不显示金额，
  //   批准 79 还是 49 就成了盲签。审计日志同理要存参数原文。
  printSection("Agent proposal");
  console.log(prettyJson(proposal));
  // prettyJson 输出缩进 JSON，多行展示每个参数——
  // 给人看的格式，宁可长不可省。

  // 3. 把提案交给应用：策略门 → 持久化记录。
  //    接下来发生什么由应用决定，不由模型决定。
  const outcome = handleProposal(paths, USER_REQUEST, proposal);
  // handleProposal 返回联合类型。kind 就是判别字段，下面三个分支会被
  // TypeScript 自动收窄，因此每种策略结果只能访问自己的数据。
  //
  // 注意这里没有 if/else 链套三层的嵌套——
  // 判别联合 + 提前 return 让每个分支都是平铺的一小段，
  // 这是"用类型结构化控制流"的直接收益。

  printSection("Policy decision");
  console.log(prettyJson(outcome.policy));
  // 三种 outcome 都带 policy 字段，所以这行在分支之前就能打印。

  if (outcome.kind === "denied") {
    // deny 与 reject 不同：deny 是系统策略直接禁止，甚至不会生成审批单；
    // reject 是已经进入人工队列后，由审核人拒绝某一条具体申请。
    //
    // 这两个词在日常语言里几乎是同义词，在本章里是两个精确概念：
    //   deny    → policy.ts 的判定，发生在进队列之前
    //   rejected→ 审批单的状态，发生在进队列之后
    printSection("Action denied");
    console.log(
      `The tool "${outcome.toolName}" is forbidden by policy and was never recorded or executed.`
    );
    return;
    // 提前返回：denied 没有后续步骤。
    // 审计日志里已留下 ACTION_DENIED 三连事件（提案/判定/拒绝）。
  }

  if (outcome.kind === "auto_executed") {
    // 低风险只读动作可以由 policy 授权后立即执行，但依然会留下审批状态、
    // execution record 和 audit event，保证不同路径具有一致的可观测性。
    //
    // auto_execute 也不是"直通车道"：照样有单、有执行记录、有审计。
    // 事后排查"昨天那个订单状态是谁查的"，
    // 答案在 store 和日志里，和退款一样完整。
    printSection("Auto-executed");
    console.log(
      `Policy allowed "${outcome.record.proposedAction.toolName}" to run automatically.`
    );
    console.log(prettyJson(outcome.execution.result));
    return;
  }

  // require_approval → 一张 pending 单此刻已存在于磁盘上。
  // 注意：程序运行到这里已经"暂停"了。pending 记录写入 JSON 后，
  // 当前进程可以安全退出，之后再通过 CLI 在另一个进程中恢复审批流程。
  //
  // 这里的"暂停"值得再强调一次：没有任何 await 等待人输入，
  // 函数马上就要返回、进程马上就要退出。
  // "等人"不是这个进程的职责——是 data/approvals.json 里
  // 那张 pending 单在等，等多久都行。
  printSection("Approval requested");
  if (outcome.duplicateOf) {
    // duplicateOf 存在 → 这次没有创建新单，复用了旧单。
    console.log(
      `An identical pending approval already exists: ${outcome.duplicateOf}.`
    );
    console.log("Not creating a duplicate. Reuse it, or run \"npm run reset\" first.");
  } else {
    console.log(`Approval ${outcome.record.id} is pending.`);
  }
  console.log("Nothing has executed yet.");
  // 这句话是全章最重要的一行输出：
  // 明确告诉用户"到目前为止，什么都没发生"。
  // 演示程序里它是教学提示；生产系统里它是给用户的
  // 安全承诺——"钱还没动"。

  printSection("Next steps");
  console.log("Review and act on the pending approval with:");
  console.log("  npm run approvals");
  console.log(
    `  npm run edit -- ${outcome.record.id} --amount=49 --reason="Partial refund approved after review"`
  );
  // 注意 edit 示例里的金额是 49：
  // 引导用户复现 README 的"部分退款"故事线（79 → 49）。
  console.log(`  npm run approve -- ${outcome.record.id}`);
  console.log(`  npm run reject -- ${outcome.record.id} --reason="Customer is not eligible"`);
  console.log("  npm run audit");
}

main().catch((error) => {
  // 统一兜底只负责报告错误并设置退出码，不在这里吞掉异常或伪造成功状态。
  //
  // process.exitCode = 1 而不是 process.exit(1)：
  //   exit() 立即杀死进程，可能截断还没 flush 的 stdout；
  //   设置 exitCode 让 Node 在事件循环自然结束后以该码退出，
  //   输出完整、退出码正确，两全其美。
  console.error("\nRun failed:", (error as Error).message);
  process.exitCode = 1;
});

// ============================================================
//  本文件小结：一次运行的生命周期
// ============================================================
//
// npm start 做的事（require_approval 场景）：
//
//   用户请求 ──► proposeAction ──► ActionProposal（已校验）
//                                    │
//                                    ▼
//                            handleProposal
//                                    │
//                      ┌─────────────┼─────────────┐
//                      ▼             ▼             ▼
//                   denied    auto_executed       pending
//                  (打印+退出)  (执行+打印)   (落盘+打印"未执行")
//
// 之后的故事在别的进程里继续：
//   npm run edit / approve / reject / audit / reset（见 cli.ts）
//
// 下一站：cli.ts，看"暂停之后"如何在另一个进程里恢复。
// ============================================================
