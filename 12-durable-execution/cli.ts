import { findWorkflow } from "./checkpointStore.js";
import { DEMO_APPROVED_ACTION, defaultPaths } from "./config.js";
import { loadEffects } from "./effectStore.js";
import { loadEventsForWorkflow } from "./eventLog.js";
import { WORKFLOW_STEPS } from "./types.js";
import { prettyJson, printSection, writeJsonArray } from "./utils.js";
import { createWorkflow, resumeWorkflow, runWorkflow, SimulatedCrashError } from "./workflowRunner.js";

// A small command-line interface for manually exploring the crash/resume
// lifecycle. Each npm script maps to one subcommand: crash, resume, status,
// effects, events, reset. `npm run crash` deliberately runs only phase 1 (up
// to the injected crash) and leaves the workflow sitting in the dangerous
// window; `npm run resume` represents a fresh process picking it back up.

function requireId(positionals: string[], command: string): string {
  const id = positionals[0];
  if (!id) {
    throw new Error(`Missing workflow id. Usage: npm run ${command} -- WF-001`);
  }
  return id;
}

function main(): void {
  const paths = defaultPaths();
  const [command, ...positionals] = process.argv.slice(2);

  switch (command) {
    case "crash": {
      // Creates a fresh workflow from the fixed demo input and runs it into
      // the dangerous window: the refund provider succeeds, then the process
      // "crashes" before execute_refund is checkpointed.
      const workflow = createWorkflow(paths, DEMO_APPROVED_ACTION);
      printSection(`Workflow ${workflow.id} created`);
      console.log(prettyJson(DEMO_APPROVED_ACTION));

      try {
        runWorkflow(paths, workflow.id, { crashAfterSideEffectStep: "execute_refund" });
      } catch (error) {
        if (!(error instanceof SimulatedCrashError)) throw error;
        printSection("💥 Simulated process crash");
        console.log(error.message);
        console.log(`\nWorkflow ${workflow.id} is left mid-flight. Inspect it with:`);
        console.log(`  npm run status -- ${workflow.id}`);
        console.log("  npm run effects");
        console.log(`\nThen resume it with:`);
        console.log(`  npm run resume -- ${workflow.id}`);
        break;
      }
      // If no crash happened (e.g. the step already completed), fall through
      // to reporting the resulting state as-is.
      printSection(`Workflow ${workflow.id}`);
      console.log("Completed without hitting the crash window.");
      break;
    }

    case "resume": {
      const id = requireId(positionals, "resume");
      const before = findWorkflow(paths, id);
      if (!before) throw new Error(`No workflow found with id "${id}".`);

      if (before.status === "completed") {
        printSection(`Resume ${id}`);
        console.log(`Workflow ${id} is already complete. Nothing to resume.`);
        break;
      }

      printSection(`Resuming ${id}`);
      const resumeStep = WORKFLOW_STEPS.find((step) => !before.completedSteps.includes(step));
      console.log(`Resuming from: ${resumeStep}`);

      const { workflow } = resumeWorkflow(paths, id);
      printSection(`Workflow ${id}`);
      console.log(`Status: ${workflow.status}`);
      console.log(prettyJson(workflow.context));
      break;
    }

    case "status": {
      const id = requireId(positionals, "status");
      const workflow = findWorkflow(paths, id);
      if (!workflow) throw new Error(`No workflow found with id "${id}".`);

      printSection(`Workflow ${id}`);
      console.log(`Status: ${workflow.status}`);
      if (workflow.lastError) console.log(`Last error: ${workflow.lastError}`);

      console.log("\nCompleted:");
      const completed = WORKFLOW_STEPS.filter((step) => workflow.completedSteps.includes(step));
      if (completed.length === 0) console.log("  (none)");
      for (const step of completed) console.log(`✓ ${step}`);

      console.log("\nRemaining:");
      const remaining = WORKFLOW_STEPS.filter((step) => !workflow.completedSteps.includes(step));
      if (remaining.length === 0) console.log("  (none)");
      for (const step of remaining) console.log(`○ ${step}`);

      console.log("\nContext:");
      console.log(prettyJson(workflow.context));
      break;
    }

    case "effects": {
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
      }
      break;
    }

    case "events": {
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
      }
      break;
    }

    case "reset": {
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
  console.error(`\nError: ${(error as Error).message}`);
  process.exitCode = 1;
}
