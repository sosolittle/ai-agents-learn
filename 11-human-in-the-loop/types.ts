// ============================================================
//  第十一章数据契约：把自然语言流程变成可验证状态
//
//  学习目标：
//  1. 用 discriminated union 绑定“工具名”和“对应参数”
//  2. 区分模型提案、审批记录、执行记录、审计事件四类对象
//  3. 理解 TypeScript 类型只在编译期存在，Zod Schema 负责运行时校验
//  4. 用严格对象拒绝未知字段，防止模型越权声明权限
// ============================================================

import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Tools
// ─────────────────────────────────────────────────────────────────────────────

// The supported tools are a closed enum. The model may only propose one of
// these; anything else is rejected at the validation boundary before it can
// ever reach a policy check or an executor.
export const ToolNameSchema = z.enum([
  "getOrderStatus",
  "refundOrder",
  "cancelSubscription",
  "deleteProductionUsers",
]);
export type ToolName = z.infer<typeof ToolNameSchema>;

// Shared ID shapes. Malformed IDs fail here rather than reaching a tool.
const OrderIdSchema = z
  .string()
  .regex(/^ORD-\d+$/, 'orderId must look like "ORD-001"');
const CustomerIdSchema = z
  .string()
  .regex(/^CUS-\d+$/, 'customerId must look like "CUS-104"');

// ─────────────────────────────────────────────────────────────────────────────
// Action proposal (the model's output)
// ─────────────────────────────────────────────────────────────────────────────

// A discriminated union on `toolName`. Each tool has its own argument shape, so
// the wrong arguments for a tool fail validation. `.strict()` is applied at BOTH
// levels: the arguments object and the outer proposal object. The outer
// `.strict()` is what rejects a hidden permission field like `requiresApproval`,
// `isAuthorized`, or `allowed` — the model is never allowed to decide those.
// The model proposes capability; the application owns authorization.
export const ActionProposalSchema = z.discriminatedUnion("toolName", [
  // toolName 是判别字段。Zod 先看工具名，再选择唯一对应的参数 Schema；
  // 因此 refundOrder 不可能误带 cancelSubscription 的参数结构。
  z
    .object({
      toolName: z.literal("getOrderStatus"),
      arguments: z.object({ orderId: OrderIdSchema }).strict(),
      reason: z.string().min(1),
    })
    .strict(),
  z
    .object({
      toolName: z.literal("refundOrder"),
      arguments: z
        .object({
          orderId: OrderIdSchema,
          amount: z.number().positive("refund amount must be greater than 0"),
          currency: z.literal("EUR", {
            errorMap: () => ({ message: 'currency must be "EUR"' }),
          }),
          reason: z.string().min(1),
        })
        .strict(),
      reason: z.string().min(1),
    })
    .strict(),
  z
    .object({
      toolName: z.literal("cancelSubscription"),
      arguments: z
        .object({
          customerId: CustomerIdSchema,
          reason: z.string().min(1),
        })
        .strict(),
      reason: z.string().min(1),
    })
    .strict(),
  z
    .object({
      toolName: z.literal("deleteProductionUsers"),
      arguments: z.object({}).strict(),
      reason: z.string().min(1),
    })
    .strict(),
]);
export type ActionProposal = z.infer<typeof ActionProposalSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Policy
// ─────────────────────────────────────────────────────────────────────────────

// The three outcomes of the deterministic policy gate. This is decided by
// application code, never by the model.
export const PolicyDecisionSchema = z.enum([
  "auto_execute",
  "require_approval",
  "deny",
]);
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;

export interface PolicyResult {
  decision: PolicyDecision;
  reason: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Approval records (persisted workflow state)
// ─────────────────────────────────────────────────────────────────────────────

export const ApprovalStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "executed",
]);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;
// 正常人工审批路径：
// pending（待审核）→ approved（已授权）→ executed（已执行）
//                    ↘ rejected（已拒绝）
// approved 与 executed 必须分开：授权成功不代表副作用已经成功完成。

// The action as stored on the record. Arguments are kept as an open record here
// because a record can hold any tool's arguments; the exact shape is
// re-validated with ActionProposalSchema every time the action is about to
// change or execute.
export const ProposedActionSchema = z.object({
  toolName: ToolNameSchema,
  arguments: z.record(z.unknown()),
  reason: z.string(),
});
export type ProposedAction = z.infer<typeof ProposedActionSchema>;

export const ApprovalRecordSchema = z.object({
  // 审批记录回答“这项动作当前走到哪一步”，它是工作流状态。
  id: z.string(),
  originalRequest: z.string(),
  proposedAction: ProposedActionSchema,
  status: ApprovalStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  decisionReason: z.string().optional(),
  executionId: z.string().optional(),
});
export type ApprovalRecord = z.infer<typeof ApprovalRecordSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Executions
// ─────────────────────────────────────────────────────────────────────────────

export const ExecutionRecordSchema = z.object({
  // 执行记录回答“工具是否已经真正运行过以及结果是什么”。
  // approvalId 将一次执行绑定到一张审批单，是本地幂等恢复的依据。
  id: z.string(),
  approvalId: z.string(),
  toolName: ToolNameSchema,
  arguments: z.record(z.unknown()),
  result: z.record(z.unknown()),
  executedAt: z.string(),
});
export type ExecutionRecord = z.infer<typeof ExecutionRecordSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Audit log
// ─────────────────────────────────────────────────────────────────────────────

export const AuditEventTypeSchema = z.enum([
  "ACTION_PROPOSED",
  "POLICY_EVALUATED",
  "APPROVAL_REQUESTED",
  "ACTION_EDITED",
  "ACTION_APPROVED",
  "ACTION_REJECTED",
  "ACTION_DENIED",
  "ACTION_EXECUTED",
  "DUPLICATE_EXECUTION_BLOCKED",
  "EXISTING_EXECUTION_RECOVERED",
]);
export type AuditEventType = z.infer<typeof AuditEventTypeSchema>;

export const AuditEventSchema = z.object({
  // 审计事件是只追加的时间线，不承担当前状态查询；
  // 当前状态看 ApprovalRecord，历史过程看 AuditEvent。
  event: AuditEventTypeSchema,
  timestamp: z.string(),
  approvalId: z.string().optional(),
  toolName: ToolNameSchema.optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;
