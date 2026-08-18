import { findWorkflow } from "./checkpointStore.js";
import { DEMO_APPROVED_ACTION, defaultPaths } from "./config.js";
import { countEffectsForWorkflowByType, loadEffectsForWorkflow } from "./effectStore.js";
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

  const { workflow, reused } = createWorkflow(paths, DEMO_APPROVED_ACTION);

  // Workflow-start idempotency: this is a SEPARATE boundary from the
  // step-level idempotency key demonstrated below. It stops the SAME approval
  // from ever starting a SECOND workflow — so running "npm start" twice never
  // creates WF-002 or a second refund for APR-001.
  if (reused) {
    printSection("Workflow already exists");
    console.log(`${DEMO_APPROVED_ACTION.approvalId} already belongs to ${workflow.id}.`);
    console.log("\nNo new workflow was created.");
    console.log("No new refund was created.");
    console.log(`\nCurrent status: ${workflow.status}`);
    console.log(
      `${workflow.id} refund effects:       ${countEffectsForWorkflowByType(paths, workflow.id, "refund")}`
    );
    console.log(
      `${workflow.id} confirmation effects: ${countEffectsForWorkflowByType(paths, workflow.id, "confirmation")}`
    );
    console.log("\nRun:\n  npm run reset\nto replay the crash demonstration from a clean state.");
    return;
  }

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
  for (const effect of loadEffectsForWorkflow(paths, workflow.id)) {
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
  console.log(
    `\n${finalWorkflow.id} refund effects:       ${countEffectsForWorkflowByType(paths, finalWorkflow.id, "refund")}`
  );
  console.log(
    `${finalWorkflow.id} confirmation effects: ${countEffectsForWorkflowByType(paths, finalWorkflow.id, "confirmation")}`
  );

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
