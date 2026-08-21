// ============================================================
//  第十二章：CLI（cli.ts）
//  手动探索崩溃/恢复生命周期的六个命令
//
//  🏠 生活化比喻：导演的「分镜台本」。index.ts 是把两幕一口气
//  演完的联排；本文件把两幕拆进两个真实的剧场——
//  crash 命令在 A 剧场演到断电为止，resume 命令在 B 剧场
//  从断点接着演（更接近生产：崩溃的进程和恢复的进程
//  本来就不是同一个）。中间还能随时看白板（status）、
//  翻发票簿（effects）、放录像（events）——三个视角查同一案子。
//
//  学习目标：
//  1. 用 crash / resume 两命令把"两幕剧"拆到两个进程里演
//  2. 用 status / effects / events 三命令从三个视角查案
//  3. 复用 11 章的 CLI 纪律：只做翻译，规则都在 runner/store
//
//  与 index.ts 的分工：
//  npm start 是"一次演完的两幕剧"（方便快速看全貌）；
//  本文件的 crash + resume 把两幕拆进两个真实进程——
//  更接近生产形态（崩溃的进程和恢复的进程本来就不是一个）。
//
//  命令一览：
//    npm run reset            → 清空三个 store
//    npm run crash            → 第一幕：创建工作流并崩在窗口里
//    npm run status -- WF-001 → checkpoint 视角
//    npm run effects          → 账本视角
//    npm run resume -- WF-001 → 第二幕：新进程恢复
//    npm run events -- WF-001 → 时间线视角（含崩溃缺口）
// ============================================================

import { findWorkflow } from "./checkpointStore.js";
import { DEMO_APPROVED_ACTION, defaultPaths } from "./config.js";
import { countEffectsForWorkflowByType, loadEffects } from "./effectStore.js";
import { loadEventsForWorkflow } from "./eventLog.js";
import { WORKFLOW_STEPS } from "./types.js";
import { prettyJson, printSection, writeJsonArray } from "./utils.js";
import { createWorkflow, resumeWorkflow, runWorkflow, SimulatedCrashError } from "./workflowRunner.js";

// 一个手动探索崩溃/恢复生命周期的小型命令行接口。
// 每个 npm script 对应一个子命令：crash, resume, status,
// effects, events, reset。`npm run crash` 刻意只运行第一幕
// （到注入的崩溃为止），让工作流停在危险窗口里；
// `npm run resume` 代表一个新进程把它捡起来。

function requireId(positionals: string[], command: string): string {
  // 与 11 章同款小工具：取第一个位置参数当 ID，
  // 缺失时抛带用法的错误。
  const id = positionals[0];
  if (!id) {
    throw new Error(`Missing workflow id. Usage: npm run ${command} -- WF-001`);
  }
  return id;
}

function main(): void {
  const paths = defaultPaths();
  const [command, ...positionals] = process.argv.slice(2);
  // process.argv[2] 是子命令，其余是位置参数
  // （12 章的命令都不需要 flag，所以没有 11 章的 parseArgs）。

  switch (command) {
    case "crash": {
      // 从固定的演示输入创建一个新工作流，并把它运行进
      // 危险窗口：退款提供方成功，然后进程在 execute_refund
      // 被 checkpoint 之前"崩溃"。
      const { workflow, reused } = createWorkflow(paths, DEMO_APPROVED_ACTION);

      if (reused) {
        // 已有工作流（比如跑过 npm start 或没 reset）：
        // 不能重演崩溃——同一审批只有一条工作流（幂等边界 A）。
        // 这个分支的存在本身就是边界 A 在 CLI 上的体现。
        printSection("Workflow already exists");
        console.log(`${DEMO_APPROVED_ACTION.approvalId} already belongs to ${workflow.id}.`);
        console.log("\nNo new workflow was created. No new refund was created.");
        console.log(`\nCurrent status: ${workflow.status}`);
        console.log(
          `${workflow.id} refund effects:       ${countEffectsForWorkflowByType(paths, workflow.id, "refund")}`
        );
        console.log(
          `${workflow.id} confirmation effects: ${countEffectsForWorkflowByType(paths, workflow.id, "confirmation")}`
        );
        console.log("\nRun:\n  npm run reset\nto replay the crash demonstration from a clean state.");
        break;
      }

      printSection(`Workflow ${workflow.id} created`);
      console.log(prettyJson(DEMO_APPROVED_ACTION));

      try {
        runWorkflow(paths, workflow.id, { crashAfterSideEffectStep: "execute_refund" });
        // 第一幕：跑到退款后精确"断电"。
      } catch (error) {
        if (!(error instanceof SimulatedCrashError)) throw error;
        // 只接住模拟崩溃；真实错误继续上抛。
        printSection("💥 Simulated process crash");
        console.log(error.message);
        console.log(`\nWorkflow ${workflow.id} is left mid-flight. Inspect it with:`);
        console.log(`  npm run status -- ${workflow.id}`);
        console.log("  npm run effects");
        // 先查案再看答案——status/effects 能看到
        // "checkpoint 未记 / 账本已记"的矛盾。
        console.log(`\nThen resume it with:`);
        console.log(`  npm run resume -- ${workflow.id}`);
        break;
      }
      // If no crash happened (e.g. the step already completed), fall through
      // to reporting the resulting state as-is.
      printSection(`Workflow ${workflow.id}`);
      console.log("Completed without hitting the crash window.");
      // 什么时候会到这里？注入点要求"副作用成功后崩溃"——
      // 如果 execute_refund 早就完成（恢复过的旧数据又没 reset），
      // 崩溃条件不再满足，工作流会正常跑完。诚实报告即可。
      break;
    }

    case "resume": {
      // 第二幕：新进程恢复。
      const id = requireId(positionals, "resume");
      const before = findWorkflow(paths, id);
      if (!before) throw new Error(`No workflow found with id "${id}".`);

      if (before.status === "completed") {
        // 已完成的工作流：纯 no-op（advance 的第一个分支）。
        printSection(`Resume ${id}`);
        console.log(`Workflow ${id} is already complete. Nothing to resume.`);
        break;
      }

      printSection(`Resuming ${id}`);
      const resumeStep = WORKFLOW_STEPS.find((step) => !before.completedSteps.includes(step));
      console.log(`Resuming from: ${resumeStep}`);
      // 打印恢复点：崩溃后应该是 execute_refund。

      const { workflow } = resumeWorkflow(paths, id);
      // 恢复执行：execute_refund 幂等命中 → checkpoint
      // → send_confirmation → completed。
      printSection(`Workflow ${id}`);
      console.log(`Status: ${workflow.status}`);
      console.log(prettyJson(workflow.context));
      // 打印最终 context：{ refundId: "REF-001",
      //                     confirmationId: "MSG-001" }——
      // 两本账在工作流视角下终于对齐。
      break;
    }

    case "status": {
      // checkpoint 视角：这条工作流现在怎么样。
      const id = requireId(positionals, "status");
      const workflow = findWorkflow(paths, id);
      if (!workflow) throw new Error(`No workflow found with id "${id}".`);

      printSection(`Workflow ${id}`);
      console.log(`Status: ${workflow.status}`);
      if (workflow.lastError) console.log(`Last error: ${workflow.lastError}`);
      // failed 的工作流会显示失败原因（markFailed 存的 lastError）。

      console.log("\nCompleted:");
      const completed = WORKFLOW_STEPS.filter((step) => workflow.completedSteps.includes(step));
      if (completed.length === 0) console.log("  (none)");
      for (const step of completed) console.log(`✓ ${step}`);
      console.log("\nRemaining:");
      const remaining = WORKFLOW_STEPS.filter((step) => !workflow.completedSteps.includes(step));
      if (remaining.length === 0) console.log("  (none)");
      for (const step of remaining) console.log(`○ ${step}`);
      // crash 之后、resume 之前运行本命令，会看到：
      //   Completed: ✓ validate_approval
      //   Remaining: ○ execute_refund  ○ send_confirmation
      // 对照 effects 命令（此时 REF-001 已存在）——
      // 矛盾即窗口。

      console.log("\nContext:");
      console.log(prettyJson(workflow.context));
      break;
    }

    case "effects": {
      // 账本视角：全局副作用记录。
      const effects = loadEffects(paths);
      printSection("Side effects");
      if (effects.length === 0) {
        console.log('No side effects yet. Create one with "npm run crash" or "npm start".');
        break;
      }
      for (const effect of effects) {
        const resultId =
          effect.type === "refund" ? effect.result.refundId : effect.result.confirmationId;
        console.log(`\n${effect.key}`);
        console.log(`  ${effect.type} → ${resultId}`);
        // 每行输出：幂等键 + 类型 + 结果 ID
        //   WF-001:execute_refund
        //     refund → REF-001
        // 全部记录就这几行——"只退一次"的事实清单。
      }
      break;
    }

    case "events": {
      // 时间线视角：这条工作流的完整编年史。
      const id = requireId(positionals, "events");
      const events = loadEventsForWorkflow(paths, id);
      printSection(`Events for ${id}`);
      if (events.length === 0) {
        console.log("No events yet for this workflow.");
        break;
      }
      for (const event of events) {
        const suffix = event.step ? `  ${event.step}` : "";
        console.log(`${event.event.padEnd(24)}${suffix}`);
        // padEnd(24)：事件名补齐到 24 列再拼步骤名——
        // 所有行同一列对齐，长列表才扫得动。
        // crash + resume 后的完整时间线（README 有）：
        //   WORKFLOW_CREATED
        //   WORKFLOW_STARTED
        //   STEP_STARTED              validate_approval
        //   STEP_COMPLETED            validate_approval
        //   STEP_STARTED              execute_refund
        //   SIDE_EFFECT_EXECUTED      execute_refund
        //   WORKFLOW_RESUMED          ← 崩溃缺口之后的第一行
        //   STEP_STARTED              execute_refund
        //   SIDE_EFFECT_REUSED        execute_refund  ← 幂等命中！
        //   STEP_COMPLETED            execute_refund
        //   ...
      }
      break;
    }

    case "reset": {
      // 清空三个 store，回到干净的演示状态。
      writeJsonArray(paths.workflows, []);
      writeJsonArray(paths.effects, []);
      writeJsonArray(paths.events, []);
      printSection("Reset");
      console.log("Cleared workflows, effects, and events to a clean demo state.");
      break;
    }

    default:
      console.error(
        `Unknown command: ${command ?? "(none)"}\n` +
          "Available: crash, resume, status, effects, events, reset."
      );
      process.exitCode = 1;
  }
}

try {
  main();
} catch (error) {
  // 与 11 章 CLI 相同的收尾纪律：
  // 错误消息给人看，非零退出码给脚本/CI 看。
  console.error(`\nError: ${(error as Error).message}`);
  process.exitCode = 1;
}

// ============================================================
//  本文件小结：推荐的手动探索剧本
// ============================================================
//
//   npm run reset            # 干净开局
//   npm run crash            # 第一幕：崩在窗口里
//   npm run status -- WF-001 # 看 checkpoint：execute_refund 未完成
//   npm run effects          # 看账本：REF-001 已存在 ← 矛盾！
//   npm run resume -- WF-001 # 第二幕：另一个进程恢复
//   npm run status -- WF-001 # 全部 ✓，context 两本账对齐
//   npm run events -- WF-001 # 时间线：缺口 + SIDE_EFFECT_REUSED
//
// 📤 每一步的关键输出（照着对答案）：
//   crash   → "💥 Simulated process crash ... before the checkpoint"
//   status  → Completed: ✓ validate_approval
//             Remaining: ○ execute_refund  ○ send_confirmation
//   effects → WF-001:execute_refund → REF-001   ← 白板没勾，账本有票！
//   resume  → "Resuming from: execute_refund" → Status: completed
//   status  → 三个 ✓ + Context: { refundId: "REF-001",
//                                 confirmationId: "MSG-001" }
//   events  → SIDE_EFFECT_EXECUTED 之后直接 WORKFLOW_RESUMED（缺口），
//             随后 SIDE_EFFECT_REUSED —— 幂等命中的现场录像
//
// 三视角查案（status/effects/events）对应三个 store
// （workflows/effects/events.json）——
// CLI 命令面就是数据模型面，这是好 CLI 的特征。
// ============================================================
