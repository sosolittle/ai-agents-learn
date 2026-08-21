// ============================================================
//  第八章 trace：供评测读取的执行轨迹（草稿纸）
//
//  🏠 生活化比喻：
//  和第七章的黑匣子同源，但用途升级了：第七章它帮工程师「复盘」，
//  这一章它成为判卷证据——判卷机（evaluator）查「有没有调用
//  某工具、参数是什么」全靠翻它。所以除了记录，还多了几个
//  「按工具名查询」的便捷方法（usedTool / getToolCalls /
//  allToolNames）——给判卷机递上好翻的账本。
//
//  学习目标：
//  1. 记录 agent 每一步行为，给 evaluator 提供证据
//  2. 支持 usedTool/getToolCalls 这类评测辅助查询
//  3. 把长结果裁剪成 preview，避免评测日志过大
// ============================================================

// 事件类型（比第七章少了 retry / tool_call 重试元数据——本章无重试）。
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

  // 构造函数参数属性：private readonly runId 自动成为只读字段（见第六章讲解）。
  constructor(private readonly runId: string) {}

  record(event: Omit<TraceEvent, "runId" | "stepNumber">): TraceEvent {
    // Omit 工具类型（第七章讲过）：调用方只填事件本身，
    // runId/stepNumber 由这里统一盖章——想填错都没机会。
    // TS 语法：++this.stepNumber 是「先加一再取值」的前缀递增，
    // 一行干两件事（计数 + 作为新编号）。
    const recorded = {
      runId: this.runId,
      stepNumber: ++this.stepNumber,
      ...event,
    };
    this.events.push(recorded);
    return recorded;
  }

  all(): TraceEvent[] {
    // 浅拷贝防篡改（同第七章）。
    return [...this.events];
  }

  usedTool(name: string): boolean {
    // 「用过某工具吗」——判卷最常用的一问，封装成一行。
    return this.getToolCalls(name).length > 0;
  }

  getToolCalls(name: string): TraceEvent[] {
    // 「某工具的全部调用记录」——参数判卷（expectedArgs）用它。
    return this.events.filter(
      (event) => event.eventType === "tool_call" && event.toolName === name
    );
  }

  allToolNames(): string[] {
    // 本次运行调用过的全部工具名（去重）。
    // TS 语法：链式数组操作 + 一个新朋友——
    //   filter/map/filter 之后 [...new Set(...)] 去重（第五章手法）；
    //   中间那个 filter 的写法 (name): name is string => name !== undefined
    //   是「类型谓词」：向编译器承诺「通过这个筛选的元素一定是 string」，
    //   之后的 Set<string> 就不用再处理 undefined。
    //   （没有它，map 出来的类型是 (string | undefined)[]。）
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
    // 人读版：按步骤打印（评测主流程不打它，调试时手动调用）。
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

// runId 生成器（同第七章的讲解：36 进制随机串，砍掉 "0." 前缀）。
export function newRunId(): string {
  return Math.random().toString(36).slice(2, 10);
}

// 长文本截断（同前几章；本模块默认 140 字符）。
export function preview(value: unknown, max = 140): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length <= max ? text : `${text.slice(0, max)}...`;
}
