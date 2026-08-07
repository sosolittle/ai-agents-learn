import { findWorkflow } from "./checkpointStore.js";
import { DEMO_APPROVED_ACTION, defaultPaths } from "./config.js";
import { countEffectsByType, loadEffects } from "./effectStore.js";
import { WORKFLOW_STEPS } from "./types.js";
import { prettyJson, printSection } from "./utils.js";
import { createWorkflow, resumeWorkflow, runWorkflow, SimulatedCrashError } from "./workflowRunner.js";

// The full crash/resume story in one readable run. There is no model call
// anywhere in this file — the interesting problem starts after a proposal has
// already been proposed AND approved by the previous control layer (Module
// 11). Durable execution is an application/runtime concern, not something a
// prompt can solve.

function printStepList(completedSteps: readonly string[]): void {
  for (const step of WORKFLOW_STEPS) {
    const done = completedSteps.includes(step);
    console.log(`${done ? "✓" : "○"} ${step}`);
  }
}

function main(): void {
  console.log("AI Agents From Scratch — 12 Durable Execution");
  const paths = defaultPaths();

  printSection("Approved action");
  console.log(prettyJson(DEMO_APPROVED_ACTION));
  console.log(
    "\nThis is where Module 12 begins — after the model proposed a refund and a " +
      "human already approved it in Module 11. There is no model call in this module."
  );

  const workflow = createWorkflow(paths, DEMO_APPROVED_ACTION);
  printSection("Workflow created");
  console.log(workflow.id);

  // Phase 1: run until the injected crash. The crash lands right after the
  // refund provider succeeds and right before execute_refund is checkpointed —
  // the exact window where a naive retry would double-refund.
  try {
    runWorkflow(paths, workflow.id, { crashAfterSideEffectStep: "execute_refund" });
  } catch (error) {
    if (!(error instanceof SimulatedCrashError)) throw error;
    printSection("💥 Simulated process crash");
    console.log(error.message);
    console.log("\nThe refund succeeded, but execute_refund was NOT checkpointed.");
  }

  const crashed = findWorkflow(paths, workflow.id);
  if (!crashed) throw new Error(`Workflow ${workflow.id} vanished unexpectedly.`);

  printSection("Persisted state after the crash");
  printStepList(crashed.completedSteps);

  printSection("Side-effect ledger");
  for (const effect of loadEffects(paths)) {
    const resultId = effect.type === "refund" ? effect.result.refundId : effect.result.confirmationId;
    console.log(`${effect.key} → ${resultId}`);
  }

  // Phase 2: simulate a process restart. Nothing here reuses `crashed` or any
  // other in-memory object from phase 1 — resumeWorkflow reloads the record
  // from disk itself, exactly as a freshly started process would.
  printSection("Process restarted");
  console.log(`Reloading ${workflow.id} from persisted state...`);
  const reloaded = findWorkflow(paths, workflow.id);
  if (!reloaded) throw new Error(`Workflow ${workflow.id} vanished unexpectedly.`);
  const resumeStep = WORKFLOW_STEPS.find((step) => !reloaded.completedSteps.includes(step));
  console.log(`Resuming from: ${resumeStep}`);

  const { workflow: finalWorkflow } = resumeWorkflow(paths, workflow.id);

  printSection("Workflow completed");
  console.log(`${finalWorkflow.id}  [${finalWorkflow.status}]`);
  console.log(`\nRefund effects:       ${countEffectsByType(paths, "refund")}`);
  console.log(`Confirmation effects: ${countEffectsByType(paths, "confirmation")}`);

  printSection("Lesson");
  console.log("The checkpoint remembers where the workflow was.");
  console.log("The idempotency key prevents a replayed step from repeating the side effect.");
  console.log("\nInspect it further with:");
  console.log("  npm run status -- " + workflow.id);
  console.log("  npm run effects");
  console.log("  npm run events -- " + workflow.id);
}

try {
  main();
} catch (error) {
  console.error("\nRun failed:", (error as Error).message);
  process.exitCode = 1;
}
