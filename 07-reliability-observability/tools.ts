// Mock backend tools for the reliability demo.
//
// These stand in for whatever your real backend does — a database query, an
// HTTP call, a cache lookup. The point of the demo is the agent loop around
// them, not the tools themselves.
//
// getOrderStatus is rigged to fail on its first call so we can show what a
// transient backend error looks like from the agent's perspective, and how a
// retry recovers.

export interface ToolResult {
  ok: true;
  value: unknown;
}

export interface ToolError {
  ok: false;
  error: string;
  // Whether retrying might help. Transient errors (timeouts, 503s) — yes.
  // Permanent errors (404, invalid input) — no. The agent shouldn't burn
  // iterations retrying a tool that will fail the same way every time.
  retryable: boolean;
}

export type ToolOutcome = ToolResult | ToolError;

// Per-tool state. In a real system this would be the database / HTTP client.
// Here it's a counter so we can deterministically fail the first call.
let getOrderStatusAttempts = 0;

export function resetToolState(): void {
  getOrderStatusAttempts = 0;
}

export async function getOrderStatus(orderId: string): Promise<ToolOutcome> {
  getOrderStatusAttempts++;

  // First call fails with a transient error — the kind of thing you'd see
  // from a flaky database connection or an overloaded upstream service.
  if (getOrderStatusAttempts === 1) {
    return { ok: false, error: "Temporary database timeout", retryable: true };
  }

  if (orderId === "ORD-001") {
    return {
      ok: true,
      value: { status: "shipped", trackingNumber: "TRK-123", carrier: "UPS" },
    };
  }

  // Permanent error — retrying won't help, the order genuinely doesn't exist.
  return { ok: false, error: `Order not found: ${orderId}`, retryable: false };
}

export async function checkInventory(productName: string): Promise<ToolOutcome> {
  const stock: Record<string, number> = {
    "Wireless Headphones": 14,
    "USB-C Cable": 0,
  };
  const count = stock[productName];
  if (count === undefined) {
    return { ok: false, error: `Unknown product: ${productName}`, retryable: false };
  }
  return { ok: true, value: { product: productName, inStock: count > 0, units: count } };
}

// Terminal tool — calling this ends the run. Same pattern as 03-agent-loop:
// completion is an explicit decision the agent commits to, not just the
// absence of more tool calls.
export async function finalAnswer(content: string): Promise<ToolOutcome> {
  return { ok: true, value: { final: content } };
}

// Dispatcher. The model can only ask for a tool by name — the security
// boundary lives here. Unknown names get a clear error instead of crashing.
export async function runTool(
  name: string,
  args: Record<string, unknown>
): Promise<ToolOutcome> {
  switch (name) {
    case "getOrderStatus":
      if (typeof args.orderId !== "string") {
        return { ok: false, error: "orderId must be a string", retryable: false };
      }
      return getOrderStatus(args.orderId);

    case "checkInventory":
      if (typeof args.productName !== "string") {
        return { ok: false, error: "productName must be a string", retryable: false };
      }
      return checkInventory(args.productName);

    case "finalAnswer":
      if (typeof args.content !== "string") {
        return { ok: false, error: "content must be a string", retryable: false };
      }
      return finalAnswer(args.content);

    default:
      return { ok: false, error: `Unknown tool: ${name}`, retryable: false };
  }
}

export const ALLOWED_TOOLS = new Set(["getOrderStatus", "checkInventory", "finalAnswer"]);
