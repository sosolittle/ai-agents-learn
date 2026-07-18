import type { PolicyDecision, PolicyResult, ToolName } from "./types.js";

// The policy gate. This is the heart of the module's lesson: capability is not
// permission. The model decides which tool could satisfy a request; this table
// — plain application code, not a prompt — decides whether that tool may run
// automatically, needs a human, or is forbidden.
//
// It is deterministic, typed, and trivial to extend: add a tool, add a policy.
// The decision never depends on the model's explanation of what it wants to do.
const TOOL_POLICIES: Record<ToolName, PolicyResult> = {
  // Read-only lookup, no side effects: safe to run without a human.
  getOrderStatus: {
    decision: "auto_execute",
    reason: "Read-only status lookup with no side effects.",
  },
  // Money movement: never automatic, always a human decision.
  refundOrder: {
    decision: "require_approval",
    reason: "Financial actions cannot execute automatically.",
  },
  // Account-changing and externally visible: needs a human.
  cancelSubscription: {
    decision: "require_approval",
    reason: "Account-changing actions cannot execute automatically.",
  },
  // Destructive production-data action: forbidden outright, never approvable.
  deleteProductionUsers: {
    decision: "deny",
    reason: "Destructive production-data actions are forbidden.",
  },
};

/**
 * Evaluate the deterministic policy for a tool.
 *
 * Fails closed: a tool with no policy is denied, not allowed. A new tool that
 * someone forgets to classify can never slip through as auto-executable.
 */
export function evaluatePolicy(toolName: ToolName): PolicyResult {
  const policy = TOOL_POLICIES[toolName];
  if (!policy) {
    return {
      decision: "deny" satisfies PolicyDecision,
      reason: `No policy is defined for "${toolName}". Denying by default.`,
    };
  }
  return policy;
}
