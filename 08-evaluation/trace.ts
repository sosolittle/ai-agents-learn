// ============================================================
//  第八章 trace：供评测读取的执行轨迹
//
//  学习目标：
//  1. 记录 agent 每一步行为，给 evaluator 提供证据
//  2. 支持 usedTool/getToolCalls 这类评测辅助查询
//  3. 把长结果裁剪成 preview，避免评测日志过大
// ============================================================

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
  // 这个 Trace 比第七章版本更偏评测：
  // 除了记录事件，还提供按工具名查询的便捷方法。
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
