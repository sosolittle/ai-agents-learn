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

  printSection("Policy decision");
  console.log(prettyJson(outcome.policy));

  if (outcome.kind === "denied") {
    printSection("Action denied");
    console.log(
      `The tool "${outcome.toolName}" is forbidden by policy and was never recorded or executed.`
    );
    return;
  }

  if (outcome.kind === "auto_executed") {
    printSection("Auto-executed");
    console.log(
      `Policy allowed "${outcome.record.proposedAction.toolName}" to run automatically.`
    );
    console.log(prettyJson(outcome.execution.result));
    return;
  }

  // require_approval → a pending record now exists on disk.
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
  console.error("\nRun failed:", (error as Error).message);
  process.exitCode = 1;
});
