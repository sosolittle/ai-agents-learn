// A trace is the agent's flight recorder. Every meaningful step writes one
// event: what the model decided, what tool ran, what came back, what failed,
// whether we retried, why the loop stopped.
//
// In production this would write to a database, OpenTelemetry, or a service
// like Langfuse. Here it's an in-memory array — same shape, no infra.

export type EventType =
  | "model_decision"
  | "tool_call"
  | "tool_result"
  | "tool_error"
  | "retry"
  | "final_answer"
  | "stop";

export interface TraceEvent {
  runId: string;
  stepNumber: number;
  eventType: EventType;
  toolName?: string;
  arguments?: Record<string, unknown>;
  resultPreview?: string;
  error?: string;
  durationMs?: number;
  stopReason?: string;
  // Extra context. Kept loose so callers can attach what they need without
  // expanding the schema every time.
  meta?: Record<string, unknown>;
}

export class Trace {
  readonly runId: string;
  private events: TraceEvent[] = [];
  private step = 0;

  constructor(runId: string) {
    this.runId = runId;
  }

  // Append an event. The step number is assigned here so callers can't get it
  // wrong by tracking it themselves.
  record(event: Omit<TraceEvent, "runId" | "stepNumber">): TraceEvent {
    this.step++;
    const full: TraceEvent = { runId: this.runId, stepNumber: this.step, ...event };
    this.events.push(full);
    return full;
  }

  all(): TraceEvent[] {
    return this.events;
  }

  // Pretty-print the run. The point of a trace isn't to look nice — it's so a
  // tired engineer at 11pm can read what happened in order, without grep.
  print(): void {
    console.log(`\n[run ${this.runId}]`);
    for (const e of this.events) {
      const head = `[step ${e.stepNumber}] ${e.eventType}${e.toolName ? " " + e.toolName : ""}`;
      console.log(head);

      if (e.arguments) {
        console.log(`  args: ${JSON.stringify(e.arguments)}`);
      }
      if (e.resultPreview !== undefined) {
        console.log(`  result: ${e.resultPreview}`);
      }
      if (e.error) {
        console.log(`  error: ${e.error}`);
      }
      if (e.durationMs !== undefined) {
        console.log(`  durationMs: ${e.durationMs}`);
      }
      if (e.stopReason) {
        console.log(`  stopReason: ${e.stopReason}`);
      }
      if (e.meta) {
        for (const [k, v] of Object.entries(e.meta)) {
          console.log(`  ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
        }
      }
      console.log();
    }
  }
}

// Keep tool results short in the trace. Full payloads still flow through the
// agent — this is just what we record. Big blobs in logs are how disks fill
// up and how secrets leak by accident.
export function preview(value: unknown, max = 120): string {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  if (s.length <= max) return s;
  return s.slice(0, max) + "…";
}

// Tiny run-id generator. Real systems use UUIDs or ULIDs; this is enough to
// group steps in a single run without pulling in a dependency.
export function newRunId(): string {
  return Math.random().toString(36).slice(2, 10);
}
