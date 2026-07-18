import { ActionProposalSchema, type ToolName } from "./types.js";

// Mock business data and tools. Nothing here performs a real refund,
// cancellation, or database change — every tool returns a typed mock result
// marked `mock: true`. The point is the approval workflow around the tools, not
// the integrations.

export interface Order {
  orderId: string;
  customerId: string;
  totalAmount: number;
  currency: "EUR";
  status: "delivered" | "in_transit" | "cancelled";
}

// The single order the demo works with.
const MOCK_ORDERS: Record<string, Order> = {
  "ORD-001": {
    orderId: "ORD-001",
    customerId: "CUS-104",
    totalAmount: 79,
    currency: "EUR",
    status: "delivered",
  },
};

export interface OrderStatusResult extends Order {
  mock: true;
}

export interface RefundResult {
  refundId: string;
  orderId: string;
  amount: number;
  currency: "EUR";
  status: "processed";
  mock: true;
}

export interface CancellationResult {
  cancellationId: string;
  customerId: string;
  status: "cancelled";
  mock: true;
}

function getOrder(orderId: string): Order {
  const order = MOCK_ORDERS[orderId];
  if (!order) throw new Error(`Unknown order: ${orderId}`);
  return order;
}

/** Read-only order lookup. Auto-executes under policy. */
export function getOrderStatus(args: { orderId: string }): OrderStatusResult {
  return { ...getOrder(args.orderId), mock: true };
}

/** Mock refund. The refundId is supplied by the executor so it is deterministic and persisted. */
export function refundOrder(
  args: { orderId: string; amount: number; currency: "EUR"; reason: string },
  refundId: string
): RefundResult {
  const order = getOrder(args.orderId);
  if (args.amount > order.totalAmount) {
    throw new Error(
      `Refund amount ${args.amount} exceeds order total ${order.totalAmount}.`
    );
  }
  return {
    refundId,
    orderId: args.orderId,
    amount: args.amount,
    currency: args.currency,
    status: "processed",
    mock: true,
  };
}

/** Mock subscription cancellation. Requires approval under policy. */
export function cancelSubscription(
  args: { customerId: string; reason: string },
  cancellationId: string
): CancellationResult {
  return {
    cancellationId,
    customerId: args.customerId,
    status: "cancelled",
    mock: true,
  };
}

/**
 * Forbidden tool. It has no working implementation on purpose: even if a bug or
 * a bad call somehow got past the policy layer, there is nothing here that could
 * delete anything. This is defense in depth — the policy denies it, and the
 * executor refuses it, and the tool itself throws.
 */
export function deleteProductionUsers(): never {
  throw new Error(
    "deleteProductionUsers is a forbidden action with no executable implementation. " +
      "It is denied by policy and must never reach an executor."
  );
}

// Prefix used for each tool's result ID, so refunds get REF-001, REF-002, etc.
export const RESULT_ID_PREFIX: Record<ToolName, string> = {
  getOrderStatus: "LKP",
  refundOrder: "REF",
  cancelSubscription: "CAN",
  deleteProductionUsers: "DEL",
};

/**
 * Dispatch a validated action to its mock tool and return the typed result.
 *
 * Defense in depth: the arguments are re-validated against the discriminated
 * union here, right before the call, so a record whose arguments drifted out of
 * shape can never reach a tool. `resultId` is the deterministic ID the tool
 * stamps onto its result (e.g. a refundId).
 */
export function runTool(
  toolName: ToolName,
  args: Record<string, unknown>,
  resultId: string
): Record<string, unknown> {
  const proposal = ActionProposalSchema.parse({
    toolName,
    arguments: args,
    // `reason` is required by the schema but irrelevant to execution; supply a
    // placeholder so validation focuses on the arguments.
    reason: "revalidated before execution",
  });

  switch (proposal.toolName) {
    case "getOrderStatus":
      return { ...getOrderStatus(proposal.arguments) };
    case "refundOrder":
      return { ...refundOrder(proposal.arguments, resultId) };
    case "cancelSubscription":
      return { ...cancelSubscription(proposal.arguments, resultId) };
    case "deleteProductionUsers":
      // Unreachable in practice — policy denies it long before here — but the
      // tool still refuses if it is somehow called.
      return deleteProductionUsers();
    default: {
      const exhaustive: never = proposal;
      throw new Error(`Unhandled tool: ${JSON.stringify(exhaustive)}`);
    }
  }
}
