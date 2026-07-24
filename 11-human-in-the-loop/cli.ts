// ============================================================
//  Approval CLI：在不同进程中恢复并推进人工审批
//
//  学习目标：
//  1. 用 list / edit / approve / reject 操作持久化审批单
//  2. 理解 CLI 只是输入适配层，所有业务规则仍在 approvalService
//  3. 观察人工审批不是阻塞式 readline，而是可暂停、可恢复的工作流
//  4. 通过 audit 命令查看完整生命周期
// ============================================================

import {
  approveApproval,
  editApproval,
  rejectApproval,
  resetDemo,
} from "./approvalService.js";
import { loadApprovals } from "./approvalStore.js";
import { loadAudit } from "./auditLog.js";
import { defaultPaths } from "./config.js";
import { prettyJson, printSection } from "./utils.js";

// A small command-line interface over the approval lifecycle. Each npm script
// maps to one subcommand: list, edit, approve, reject, audit, reset. The
// proposal step itself lives in index.ts (npm start), because it is the only
// part that calls the model.

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string>;
}

/** Parse "APR-001 --amount=49 --reason=Text" and "--reason Text" into args. */
function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string> = {};

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith("--")) {
      // 同时支持 --amount=49 与 --amount 49。
      // 所有 flag 先保留为字符串，字段保护、类型转换和 Schema 校验交给 service。
      const body = token.slice(2);
      const eq = body.indexOf("=");
      if (eq !== -1) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        flags[body] = argv[++i];
      } else {
        flags[body] = "true";
      }
    } else {
      positionals.push(token);
    }
  }

  return { positionals, flags };
}

function requireId(positionals: string[], command: string): string {
  const id = positionals[0];
  if (!id) {
    throw new Error(`Missing approval id. Usage: npm run ${command} -- APR-001`);
  }
  return id;
}

function main(): void {
  const paths = defaultPaths();
  // npm run approve -- APR-001 最终会形成：
  // process.argv.slice(2) === ["approve", "APR-001"]。
  const [command, ...rest] = process.argv.slice(2);
  const { positionals, flags } = parseArgs(rest);

  switch (command) {
    case "list": {
      // list 只读取持久化记录，不调用模型，也不改变审批状态。
      const approvals = loadApprovals(paths);
      printSection("Approvals");
      if (approvals.length === 0) {
        console.log("No approvals yet. Create one with \"npm start\".");
        break;
      }
      for (const record of approvals) {
        const args = prettyJson(record.proposedAction.arguments).replace(/\n/g, "\n    ");
        console.log(
          `- ${record.id}  [${record.status}]  ${record.proposedAction.toolName}` +
            (record.executionId ? `  → ${record.executionId}` : "") +
            `\n    ${args}`
        );
      }
      break;
    }

    case "edit": {
      const id = requireId(positionals, "edit");
      // All flags are passed through as argument edits; the service rejects any
      // protected field and re-validates the merged arguments.
      const { before, after } = editApproval(paths, id, flags);
      // CLI 展示 before/after，让审核人确认实际写入的参数变化。
      printSection(`Edited ${id}`);
      console.log("Before:");
      console.log(prettyJson(before));
      console.log("\nAfter:");
      console.log(prettyJson(after));
      console.log("\nStill pending. Re-validated. Nothing has executed yet.");
      break;
    }

    case "approve": {
      const id = requireId(positionals, "approve");
      const outcome = approveApproval(paths, id);
      // blocked 与 recovered 都不会再次调用工具：
      // blocked 表示审批单已经是 executed；
      // recovered 表示执行记录存在，但审批状态需要补齐。
      if (outcome.blocked) {
        printSection(`Approve ${id}`);
        console.log(
          `Already executed as ${outcome.record.executionId}. ` +
            "Duplicate execution blocked — the tool was not called again."
        );
        break;
      }
      if (outcome.execution?.recovered) {
        printSection(`Approve ${id}`);
        console.log(
          `An execution already existed for this approval (${outcome.execution.executionId}). ` +
            "Reused it — the tool was not called again. Record reconciled to executed."
        );
        console.log(prettyJson(outcome.execution.result));
        break;
      }
      printSection(`Approved ${id}`);
      console.log(`Executed as ${outcome.execution?.executionId}. Mock result:`);
      console.log(prettyJson(outcome.execution?.result));
      break;
    }

    case "reject": {
      const id = requireId(positionals, "reject");
      const reason = flags.reason ?? "";
      const record = rejectApproval(paths, id, reason);
      printSection(`Rejected ${id}`);
      console.log(`Reason: ${record.decisionReason}`);
      console.log("The tool was not executed and cannot be approved.");
      break;
    }

    case "audit": {
      // 审计命令输出追加式事件时间线；它不根据当前 approval 状态反推历史。
      const events = loadAudit(paths);
      printSection("Audit log");
      if (events.length === 0) {
        console.log("No audit events yet.");
        break;
      }
      for (const event of events) {
        const suffix = [
          event.approvalId ? `approval=${event.approvalId}` : "",
          event.toolName ? `tool=${event.toolName}` : "",
        ]
          .filter(Boolean)
          .join(" ");
        console.log(`- ${event.timestamp}  ${event.event}${suffix ? `  (${suffix})` : ""}`);
      }
      break;
    }

    case "reset": {
      resetDemo(paths);
      printSection("Reset");
      console.log("Cleared approvals, executions, and the audit log to a clean demo state.");
      break;
    }

    default:
      console.error(
        `Unknown command: ${command ?? "(none)"}\n` +
          "Available: list, edit, approve, reject, audit, reset."
      );
      process.exitCode = 1;
  }
}

try {
  main();
} catch (error) {
  // CLI 将 service 的明确错误转成非零退出码，方便脚本或 CI 判断操作失败。
  console.error(`\nError: ${(error as Error).message}`);
  process.exitCode = 1;
}
