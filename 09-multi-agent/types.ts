import { z } from "zod";

export const PlannerOutputSchema = z.object({
  objective: z.string(),
  user_type: z.string(),
  must_have_features: z.array(z.string()),
  nice_to_have_features: z.array(z.string()),
  technical_constraints: z.array(z.string()),
  risks: z.array(z.string()),
  acceptance_criteria: z.array(z.string()),
});

export const WorkerDraftSchema = z.object({
  product_scope: z.string(),
  data_model: z.array(z.string()),
  api_endpoints: z.array(z.string()),
  frontend_screens: z.array(z.string()),
  development_sequence: z.array(z.string()),
  tradeoffs: z.array(z.string()),
});

export const ReviewResultSchema = z.object({
  final_recommendation: z.enum(["approve", "revise"]),
  missing_items: z.array(z.string()),
  risky_claims: z.array(z.string()),
  improvement_notes: z.array(z.string()),
});

export type PlannerOutput = z.infer<typeof PlannerOutputSchema>;
export type WorkerDraft = z.infer<typeof WorkerDraftSchema>;
export type ReviewResult = z.infer<typeof ReviewResultSchema>;

export interface AgentStep {
  agent: "planner" | "worker" | "reviewer";
  summary: string;
}

export interface MultiAgentRunResult {
  goal: string;
  plan: PlannerOutput;
  draft: WorkerDraft;
  review: ReviewResult;
  steps: AgentStep[];
}
