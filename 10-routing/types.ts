import { z } from "zod";

// The six execution paths a request can take. The router's only job is to pick
// one of these — it does not execute anything itself.
export const RouteNameSchema = z.enum([
  "direct_answer",
  "tool_use",
  "research",
  "multi_agent",
  "human_approval",
  "refuse",
]);

// The router's structured decision. This is a contract: every routing decision
// has the same shape, so it can be logged, evaluated, and audited.
export const RouterDecisionSchema = z.object({
  route: RouteNameSchema,
  confidence: z.number().min(0).max(1),
  reason: z.string(),
  risk_level: z.enum(["low", "medium", "high"]),
  required_capabilities: z.array(z.string()),
  next_step: z.string(),
});

export type RouteName = z.infer<typeof RouteNameSchema>;
export type RouterDecision = z.infer<typeof RouterDecisionSchema>;

// One request paired with the decision the router made about it. This is the
// object you would store or feed to an eval harness.
export interface RoutedRequest {
  request: string;
  decision: RouterDecision;
  handlerResult: string;
}
