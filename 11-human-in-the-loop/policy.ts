// ============================================================
//  Policy Gate：用确定性代码决定执行权限
//
//  学习目标：
//  1. 理解 policy 是授权边界，不是另一个 Agent
//  2. 用 Record<ToolName, ...> 强制每个工具都有明确策略
//  3. 掌握 auto_execute / require_approval / deny 三种决策
//  4. 学会默认拒绝（fail closed），避免新工具意外获得权限
// ============================================================

import type { PolicyDecision, PolicyResult, ToolName } from "./types.js";

// The policy gate. This is the heart of the module's lesson: capability is not
// permission. The model decides which tool could satisfy a request; this table
// — plain application code, not a prompt — decides whether that tool may run
// automatically, needs a human, or is forbidden.
//
// It is deterministic, typed, and trivial to extend: add a tool, add a policy.
// The decision never depends on the model's explanation of what it wants to do.
const TOOL_POLICIES: Record<ToolName, PolicyResult> = {
  // Record 的键是 ToolName：以后给 ToolNameSchema 新增工具却忘记配置策略时，
  // TypeScript 会直接报错，而不是让新工具默认为“可以执行”。
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
  // 按当前静态类型，这个分支通常不会发生；保留运行时兜底，是因为真实系统
  // 可能收到旧数据、外部输入，或未来通过非 TypeScript 边界调用这里。
  if (!policy) {
    return {
      decision: "deny" satisfies PolicyDecision,
      reason: `No policy is defined for "${toolName}". Denying by default.`,
    };
  }
  return policy;
}
