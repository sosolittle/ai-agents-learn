// ============================================================
//  第十一章：human-in-the-loop（人在回路中的审批）
//
//  学习目标：
//  1. 区分“模型有能力提出动作”和“系统允许执行动作”
//  2. 看懂 proposal → policy → approval → execution 的完整控制链
//  3. 理解高风险动作为什么必须先持久化，再由人稍后审批
//  4. 观察入口文件只负责串联流程，不把安全策略写进 prompt
//
//  核心结论：
//  Agent 只能提出建议；真正的执行权限必须由确定性代码和人类共同控制。
// ============================================================

import "dotenv/config";

import { proposeAction } from "./actionAgent.js";
import { handleProposal } from "./approvalService.js";
import { defaultPaths } from "./config.js";
import { prettyJson, printSection } from "./utils.js";

// The fixed demonstration request. It maps to a financial action (a refund),
// which the policy layer classifies as require_approval — so this run proposes
// and pauses. Nothing executes until a human approves it with the CLI.
const USER_REQUEST =
  "Refund €79.00 for order ORD-001 because the package arrived damaged.";
// 这里固定使用退款场景，是为了稳定演示 require_approval 分支。
// 如果换成查询订单状态，会进入 auto_execute；换成删除生产用户，则会进入 deny。

async function main(): Promise<void> {
  console.log("AI Agents From Scratch — 11 Human-in-the-Loop\n");
  const paths = defaultPaths();

  printSection("User request");
  console.log(USER_REQUEST);

  // 1. The model proposes a tool and arguments. This is the ONLY model call.
  //    It describes capability — what could satisfy the request — not permission.
  let proposal: Awaited<ReturnType<typeof proposeAction>>;
  try {
    proposal = await proposeAction(USER_REQUEST);
  } catch (error) {
    // 给错误标记阶段，方便区分是模型提案失败，还是后续策略/执行失败。
    console.error({ stage: "propose", error: (error as Error).message });
    throw error;
  }

  // 2. The proposal is already validated by the agent (Zod). Print exactly what
  //    the model proposed — the human must see the real tool and arguments.
  printSection("Agent proposal");
  console.log(prettyJson(proposal));

  // 3. Hand the proposal to the application: policy gate → persistent record.
  //    The application, not the model, decides what may happen next.
  const outcome = handleProposal(paths, USER_REQUEST, proposal);
  // handleProposal 返回联合类型。kind 就是判别字段，下面三个分支会被
  // TypeScript 自动收窄，因此每种策略结果只能访问自己的数据。

  printSection("Policy decision");
  console.log(prettyJson(outcome.policy));

  if (outcome.kind === "denied") {
    // deny 与 reject 不同：deny 是系统策略直接禁止，甚至不会生成审批单；
    // reject 是已经进入人工队列后，由审核人拒绝某一条具体申请。
    printSection("Action denied");
    console.log(
      `The tool "${outcome.toolName}" is forbidden by policy and was never recorded or executed.`
    );
    return;
  }

  if (outcome.kind === "auto_executed") {
    // 低风险只读动作可以由 policy 授权后立即执行，但依然会留下审批状态、
    // execution record 和 audit event，保证不同路径具有一致的可观测性。
    printSection("Auto-executed");
    console.log(
      `Policy allowed "${outcome.record.proposedAction.toolName}" to run automatically.`
    );
    console.log(prettyJson(outcome.execution.result));
    return;
  }

  // require_approval → a pending record now exists on disk.
  // 注意：程序运行到这里已经“暂停”了。pending 记录写入 JSON 后，
  // 当前进程可以安全退出，之后再通过 CLI 在另一个进程中恢复审批流程。
  printSection("Approval requested");
  if (outcome.duplicateOf) {
    console.log(
      `An identical pending approval already exists: ${outcome.duplicateOf}.`
    );
    console.log("Not creating a duplicate. Reuse it, or run \"npm run reset\" first.");
  } else {
    console.log(`Approval ${outcome.record.id} is pending.`);
  }
  console.log("Nothing has executed yet.");

  printSection("Next steps");
  console.log("Review and act on the pending approval with:");
  console.log("  npm run approvals");
  console.log(
    `  npm run edit -- ${outcome.record.id} --amount=49 --reason="Partial refund approved after review"`
  );
  console.log(`  npm run approve -- ${outcome.record.id}`);
  console.log(`  npm run reject -- ${outcome.record.id} --reason="Customer is not eligible"`);
  console.log("  npm run audit");
}

main().catch((error) => {
  // 统一兜底只负责报告错误并设置退出码，不在这里吞掉异常或伪造成功状态。
  console.error("\nRun failed:", (error as Error).message);
  process.exitCode = 1;
});
