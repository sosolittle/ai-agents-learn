// ============================================================
//  第七章配套文件：trace（agent 的飞行记录仪）
//
//  🏠 生活化比喻：
//  飞机上的黑匣子不是为了「让飞行更好看」，而是为了万一出事，
//  能逐秒还原真相。前几章调试 agent 靠 console.log 东一榔头
//  西一棒子——出了问题只能盯着满屏散落日志猜。
//  trace 把一次运行录成「有序的事件流」：模型决定调什么、
//  工具跑成什么样、谁失败了、重试了吗、为什么停——
//  每个事件带编号（stepNumber），按顺序读就是完整故事。
//
//  学习目标：
//  1. 理解为什么 trace 是调试 agent 的核心资产
//  2. 学会把一次运行拆成连续事件：决策、调用、结果、错误、重试、停止
//  3. 看懂 runId 和 stepNumber 如何帮助你重放一次运行
//
//  核心结论：
//  出问题后第一件事不是改代码，而是「重放一次运行」。
//  只有有序的事件流（不是散落的日志行）才支撑得起重放。
// ============================================================

// A trace is the agent's flight recorder. Every meaningful step writes one
// event: what the model decided, what tool ran, what came back, what failed,
// whether we retried, why the loop stopped.
//
// In production this would write to a database, OpenTelemetry, or a service
// like Langfuse. Here it's an in-memory array — same shape, no infra.
// （生产环境会把这些事件写进数据库或可观测性平台；
//   这里用内存数组——形状相同，只是不搭基础设施。）

// TS 语法：字符串字面量的联合类型。EventType 只允许右边这七个词，
// 写错一个字母编译器就报错——事件名从此不会拼错，也方便跳读 grep。
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
  // TS 语法：字段名后的 ? = 可选属性。不是每种事件都有 toolName
  // （比如 stop 事件与工具无关），可选属性让一个接口描述多种形状。
  toolName?: string;
  arguments?: Record<string, unknown>;
  resultPreview?: string;
  error?: string;
  durationMs?: number;
  stopReason?: string;
  // Extra context. Kept loose so callers can attach what they need without
  // expanding the schema every time.
  // 附加信息。 deliberately 松散（Record<string, unknown>）——
  // 调用方想带什么就带什么，不用每加一个字段就改一遍接口。
  meta?: Record<string, unknown>;
}

export class Trace {
  // Trace 是一个很小的记录器。
  // 真实项目可以把同样的数据结构写入数据库或可观测性平台。
  readonly runId: string;
  private events: TraceEvent[] = [];
  // 步数计数器：每 record 一次 +1，事件编号由此产生。
  private step = 0;

  constructor(runId: string) {
    this.runId = runId;
  }

  // Append an event. The step number is assigned here so callers can't get it
  // wrong by tracking it themselves.
  // 记录一个事件。stepNumber 在这里内部分配——调用方自己数步数
  // 迟早会数错（漏一处、多数一处），集中管理就永远不会。
  //
  // TS 语法：Omit<TraceEvent, "runId" | "stepNumber"> 是 TS 内置的
  // 「工具类型」：Omit<某接口, "字段名"> = 「该接口去掉这些字段」的形状。
  // 效果：调用方只填事件本身，runId/stepNumber 由本方法补齐——
  // 想填都没得填，类型系统替我们守住了不变量。
  record(event: Omit<TraceEvent, "runId" | "stepNumber">): TraceEvent {
    this.step++;
    // TS 语法：对象里的 ...展开——把 event 的所有字段平铺进来。
    // 注意顺序：如果 event 里（错误地）带了 runId，写在后面的会覆盖
    // 前面的；这里 runId/stepNumber 在前，理论上不会被覆盖
    // （类型上也不允许带）。
    const full: TraceEvent = { runId: this.runId, stepNumber: this.step, ...event };
    this.events.push(full);
    return full;
  }

  all(): TraceEvent[] {
    // 返回浅拷贝，避免外部代码直接修改内部 events 数组。
    // （[...数组] 展开成新数组——改副本动不到原件。）
    return [...this.events];
  }

  // Pretty-print the run. The point of a trace isn't to look nice — it's so a
  // tired engineer at 11pm can read what happened in order, without grep.
  // 打印整次运行。目标不是好看，是「晚上 11 点排障的疲惫工程师
  // 能按顺序读完发生了什么，不用 grep」。
  print(): void {
    console.log(`\n[run ${this.runId}]`);
    for (const e of this.events) {
      // 事件头：[step 编号] 事件类型（可能带工具名）。
      // 三元的嵌套：e.toolName 存在才拼 " 工具名"，否则拼空串。
      const head = `[step ${e.stepNumber}] ${e.eventType}${e.toolName ? " " + e.toolName : ""}`;
      console.log(head);

      // 有什么字段就打什么——可选字段缺席时跳过。
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
        // TS 语法：Object.entries(对象) 返回 [键, 值] 二元组数组，
        // 配合 for-of 的数组解构 const [k, v]，逐对遍历。
        // 值是字符串就原样打，否则 JSON.stringify（数字/布尔等）。
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
// 截断长结果，只记录预览。完整数据照常流经 agent——这里只决定「记什么」。
// 日志里的大块数据是磁盘被塞满、机密被意外泄漏的经典途径。
//
// TS 语法：第二个参数 max = 120 是「默认参数」——调用时不传就用 120。
// value: unknown = 接受任何类型的值；是字符串就直接用，
// 否则 JSON.stringify 转成文本再截断（typeof 判断在运行时收窄类型）。
export function preview(value: unknown, max = 120): string {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  if (s.length <= max) return s;
  return s.slice(0, max) + "…";
}

// Tiny run-id generator. Real systems use UUIDs or ULIDs; this is enough to
// group steps in a single run without pulling in a dependency.
// 迷你 runId 生成器。真实系统用 UUID/ULID；这里 8 个字符足够把
// 「同一次运行的步骤」归成一组，还不用引依赖。
//
// TS 语法拆解：Math.random() → 0.7f3k9x2…
//   .toString(36) → "0.tr3k9x2…"（36 进制：数字+小写字母）
//   .slice(2, 10) → 砍掉开头的 "0."，取 8 个字符
export function newRunId(): string {
  return Math.random().toString(36).slice(2, 10);
}
