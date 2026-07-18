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
  const [command, ...rest] = process.argv.slice(2);
  const { positionals, flags } = parseArgs(rest);

  switch (command) {
    case "list": {
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
  console.error(`\nError: ${(error as Error).message}`);
  process.exitCode = 1;
}
