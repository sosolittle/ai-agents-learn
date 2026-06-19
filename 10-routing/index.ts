import "dotenv/config";

import { dispatch } from "./handlers.js";
import { runRouterAgent } from "./routerAgent.js";
import type { RoutedRequest } from "./types.js";
import { prettyJson, printSection } from "./utils.js";

// Six requests chosen so the reader sees a different route for each one. They go
// from the cheapest path (a plain explanation) to the one that must never run
// automatically (deleting production data).
const EXAMPLE_REQUESTS = [
  "Explain what an API is in simple terms.",
  "Check the delivery status of order ORD-001.",
  "Compare the latest pricing of two AI API providers.",
  "Create a practical MVP plan for a habit tracking app.",
  "Refund this customer and cancel their subscription.",
  "Delete all production users from the database.",
];

async function main(): Promise<void> {
  console.log("AI Agents From Scratch — 10 Routing\n");

  const results: RoutedRequest[] = [];

  for (const request of EXAMPLE_REQUESTS) {
    printSection("User request");
    console.log(request);

    // 1. Route: the router agent classifies the request. This is the only model
    //    call in the loop — classification is cheap, execution is not.
    let decision: Awaited<ReturnType<typeof runRouterAgent>>;
    try {
      decision = await runRouterAgent(request);
    } catch (error) {
      console.error({ stage: "router", request, error: (error as Error).message });
      throw error;
    }

    printSection("Router decision");
    console.log(prettyJson(decision));

    // 2. Dispatch: hand the request to the mock handler for the chosen route.
    //    In a real system this is where the actual workflow would start.
    const handlerResult = dispatch(request, decision);

    printSection("Handler result");
    console.log(`[${decision.route}] ${handlerResult}`);

    results.push({ request, decision, handlerResult });
  }

  // Every routing decision in one place: the object you would log, store, or
  // feed to an eval harness to check the router against expected routes.
  printSection("Routing summary");
  for (const { request, decision } of results) {
    console.log(
      `- ${decision.route.padEnd(14)} (${decision.risk_level}) ← ${request}`
    );
  }

  console.log(
    "\nRouting is not about making the system smarter. " +
      "It is about choosing the smallest safe path before any work runs."
  );
}

main().catch((error) => {
  console.error("Routing run failed:", error);
  process.exitCode = 1;
});
