// Shared contracts between agents.
//
// Each agent has a narrow job and a fixed output shape. Those shapes are the
// "contracts" that make the handoffs predictable: the worker knows exactly what
// the planner produces, and the reviewer knows exactly what the worker produces.
// Keeping the types small and explicit is most of what makes a multi-agent
// system readable instead of magic.

/** Planner Agent output: the structured plan derived from the user goal. */
export interface PlannerOutput {
  objective: string;
  user_type: string;
  must_have_features: string[];
  nice_to_have_features: string[];
  technical_constraints: string[];
  risks: string[];
  acceptance_criteria: string[];
}

/** Worker Agent output: a grounded MVP implementation draft. */
export interface WorkerDraft {
  product_scope: string;
  data_model: string[];
  api_endpoints: string[];
  frontend_screens: string[];
  development_sequence: string[];
  tradeoffs: string[];
}

/** Reviewer Agent output: a pass/fail judgement of the draft against the plan. */
export interface ReviewResult {
  passed: boolean;
  missing_items: string[];
  risky_claims: string[];
  improvement_notes: string[];
  final_recommendation: "approve" | "revise";
}

/** One stage in the run, captured for traceability. */
export interface AgentStep {
  agent: "planner" | "worker" | "reviewer";
  summary: string;
}

/** The complete result of one planner → worker → reviewer run. */
export interface MultiAgentRunResult {
  goal: string;
  plan: PlannerOutput;
  draft: WorkerDraft;
  review: ReviewResult;
  steps: AgentStep[];
}
