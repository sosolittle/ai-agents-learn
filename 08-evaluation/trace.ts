export type EventType =
  | "model_decision"
  | "tool_call"
  | "tool_result"
  | "tool_error"
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
  stopReason?: string;
  meta?: Record<string, unknown>;
}

export class Trace {
  private events: TraceEvent[] = [];
  private stepNumber = 0;

  constructor(private readonly runId: string) {}

  record(event: Omit<TraceEvent, "runId" | "stepNumber">): TraceEvent {
    const recorded = {
      runId: this.runId,
      stepNumber: ++this.stepNumber,
      ...event,
    };
    this.events.push(recorded);
    return recorded;
  }

  all(): TraceEvent[] {
    return [...this.events];
  }

  usedTool(name: string): boolean {
    return this.getToolCalls(name).length > 0;
  }

  getToolCalls(name: string): TraceEvent[] {
    return this.events.filter(
      (event) => event.eventType === "tool_call" && event.toolName === name
    );
  }

  allToolNames(): string[] {
    return [
      ...new Set(
        this.events
          .filter((event) => event.eventType === "tool_call")
          .map((event) => event.toolName)
          .filter((name): name is string => name !== undefined)
      ),
    ];
  }

  print(): void {
    console.log(`\n[run ${this.runId}]`);
    for (const event of this.events) {
      const tool = event.toolName ? ` ${event.toolName}` : "";
      console.log(`[step ${event.stepNumber}] ${event.eventType}${tool}`);
      if (event.arguments) console.log(`  args: ${JSON.stringify(event.arguments)}`);
      if (event.resultPreview) console.log(`  result: ${event.resultPreview}`);
      if (event.error) console.log(`  error: ${event.error}`);
      if (event.stopReason) console.log(`  stopReason: ${event.stopReason}`);
    }
  }
}

export function newRunId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function preview(value: unknown, max = 140): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length <= max ? text : `${text.slice(0, max)}...`;
}
