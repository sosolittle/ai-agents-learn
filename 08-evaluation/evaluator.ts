// ============================================================
//  第八章 evaluator：确定性评测器（客观题判卷机）
//
//  🏠 生活化比喻：
//  判卷机只批「客观题」：查没查订单、参数对不对、关键词在不在、
//  有没有超时。这些判断代码能 100% 做对，而且免费——
//  所以原则是「能用代码判的绝不请裁判（LLM judge）」，
//  裁判只留给「答得好不好」这种模糊题。
//  判卷依据是 trace（草稿纸）+ finalAnswer（答卷），
//  每道小题独立给 ✅/❌，挂了能看出挂在哪一环。
//
//  学习目标：
//  1. 学会从 trace 里检查工具是否被调用
//  2. 学会检查工具参数、最终答案关键词、停止原因和迭代次数
//  3. 理解“确定性检查”优先于“模型当裁判”
//
//  核心结论：
//  能用代码精确判断的事情，就不要交给 LLM judge。
// ============================================================

// import type = 只引入类型（编译后这行会被完全擦掉，不产生运行时代码）。
// 判卷机不需要 agent 的实现，只需要它的「答卷类型」。
import type { AgentResult } from "./agent.js";
import type { EvalCase } from "./eval-cases.js";
import type { TraceEvent } from "./trace.js";

// 一道小题的判分结果：名字 + 过没过 + 给人读的说明。
export interface EvalCheck {
  name: string;
  passed: boolean;
  message: string;
}

// 整张卷子的判分报告：case 名 + 总判定 + 全部小题 + 答案原文。
export interface EvalReport {
  caseName: string;
  passed: boolean;
  checks: EvalCheck[];
  finalAnswer: string;
}

function toolCalls(result: AgentResult, name: string): TraceEvent[] {
  // 从 trace 中筛出某个工具的调用事件。
  // 这让评测可以回答：“模型到底有没有查订单？”
  // filter + 条件的组合读作「留下……的事件」。
  return result.trace.filter(
    (event) => event.eventType === "tool_call" && event.toolName === name
  );
}

function containsExpectedArgs(
  actual: Record<string, unknown> | undefined,
  expected: Record<string, unknown>
): boolean {
  // 检查实际参数里是否包含 expected 的所有键值。
  // 这里不是深度比较完整对象，而是检查关键参数是否命中。
  //
  // TS 语法：every = 「每个都满足才 true」（有一个不满足就 false，
  // 且立刻短路返回）。数组的两兄弟：every 是 ∧（且），
  // some 是 ∨（或，下面马上用到）。
  // Object.entries 解构出 [key, value] 逐对检查；
  // actual?.[key] 的可选链：actual 为 undefined 时结果也是 undefined，
  // 自然不等于期望值——不需要单独判空。
  return Object.entries(expected).every(([key, value]) => actual?.[key] === value);
}

export function evaluateCase(testCase: EvalCase, result: AgentResult): EvalReport {
  // evaluateCase 把一个测试用例拆成多个小 check。
  // 这样失败时能看到具体是工具没调、参数错了，还是答案内容不对。
  const checks: EvalCheck[] = [];

  // ── 小题类型 1：必须调用的工具（正向清单）──────────────────
  // trace 里只要出现过一次该工具的 tool_call 事件就算过。
  for (const toolName of testCase.expectedTools ?? []) {
    const passed = toolCalls(result, toolName).length > 0;
    checks.push({
      name: `expected tool ${toolName}`,
      passed,
      message: passed
        ? `called expected tool ${toolName}`
        : `expected ${toolName} to be called, but it was not`,
    });
  }

  // ── 小题类型 2：禁止调用的工具（负向清单）──────────────────
  // 和上面正好反过来：一次都不许出现。
  for (const toolName of testCase.forbiddenTools ?? []) {
    const passed = toolCalls(result, toolName).length === 0;
    checks.push({
      name: `forbidden tool ${toolName}`,
      passed,
      message: passed
        ? `did not call forbidden tool ${toolName}`
        : `called forbidden tool ${toolName}`,
    });
  }

  // ── 小题类型 3：工具参数 ──────────────────────────────────
  // 对每个「参数有期望」的工具：该工具的调用里，至少一次（some）
  // 命中全部期望键值（every，在 containsExpectedArgs 里）。
  // 失败信息把实际见到的参数全部列出来，方便对比错在哪。
  for (const [toolName, expected] of Object.entries(testCase.expectedArgs ?? {})) {
    const calls = toolCalls(result, toolName);
    const passed = calls.some((call) => containsExpectedArgs(call.arguments, expected));
    const seen = calls.map((call) => JSON.stringify(call.arguments ?? {})).join(", ") || "(no calls)";
    checks.push({
      name: `${toolName} arguments`,
      passed,
      message: passed
        ? `${toolName} args matched ${JSON.stringify(expected)}`
        : `expected ${toolName} to be called with ${JSON.stringify(expected)}, but saw ${seen}`,
    });
  }

  // ── 小题类型 4/5/6：答案关键词 ────────────────────────────
  // 4) contains：每个词都必须在（大小写不敏感——两边都 toLowerCase）。
  const answer = result.finalAnswer.toLowerCase();
  for (const term of testCase.expectedAnswerContains ?? []) {
    const passed = answer.includes(term.toLowerCase());
    checks.push({
      name: `answer contains ${term}`,
      passed,
      message: passed
        ? `final answer contained "${term}"`
        : `final answer did not contain "${term}"`,
    });
  }

  // 5) containsAny：命中任意一个词就过（模型的措辞不止一种正确答案）。
  const anyTerms = testCase.expectedAnswerContainsAny ?? [];
  if (anyTerms.length > 0) {
    const passed = anyTerms.some((term) => answer.includes(term.toLowerCase()));
    checks.push({
      name: "answer contains any expected term",
      passed,
      message: passed
        ? `final answer contained at least one of: ${anyTerms.join(", ")}`
        : `final answer did not contain any of: ${anyTerms.join(", ")}`,
    });
  }

  // 6) mustNotContain：一个都不许在（防幻觉暗桩）。
  for (const term of testCase.answerMustNotContain ?? []) {
    const passed = !answer.includes(term.toLowerCase());
    checks.push({
      name: `answer excludes ${term}`,
      passed,
      message: passed
        ? `final answer did not contain "${term}"`
        : `final answer must not contain "${term}"`,
    });
  }

  // ── 小题类型 7：限时（迭代数）─────────────────────────────
  // 默认 6 圈内做完。跑太多圈 = 效率问题，也常是「绕圈」的前兆。
  const maxIterations = testCase.maxIterations ?? 6;
  checks.push({
    name: "iteration limit",
    passed: result.iterations <= maxIterations,
    message:
      result.iterations <= maxIterations
        ? `finished in ${result.iterations}/${maxIterations} iterations`
        : `used ${result.iterations} iterations; maximum is ${maxIterations}`,
  });

  // ── 小题类型 8：停止原因 ──────────────────────────────────
  // 保险丝熔断（max_iterations_exceeded）不算正常完成——
  // 哪怕答案碰巧像样，也不给过。
  const acceptableStop = result.stopReason !== "max_iterations_exceeded";
  checks.push({
    name: "stop reason",
    passed: acceptableStop,
    message: acceptableStop
      ? `stopped with ${result.stopReason}`
      : "stopped because max iterations were exceeded",
  });

  // 总判定 = 所有小题全过（every）。任何一环挂了，passed 都是 false，
  // 但 checks 数组保留了每一环的细节——「挂在哪」和「挂没挂」同样重要。
  return {
    caseName: testCase.name,
    passed: checks.every((check) => check.passed),
    checks,
    finalAnswer: result.finalAnswer,
  };
}

// ============================================================
//  📤 附：判卷走查（以第 1 题 "Looks up a shipped order" 为例）
//
//  agent 的答卷（AgentResult 摘要）：
//    stopReason: "terminal_tool"，iterations: 3
//    trace 里出现过：tool_call getOrderStatus {orderId:"ORD-001"}
//    finalAnswer: "Order ORD-001 has shipped.
//                  The tracking number is TRK-789."
//
//  判卷机逐项打分：
//    expectedTools   [getOrderStatus] → trace 命中 1 次        ✅
//    forbiddenTools  [checkInventory, deleteOrder] → 0 次      ✅ ✅
//    expectedArgs    {orderId:"ORD-001"} → some+every 命中     ✅
//    contains        ["shipped","TRK-789"] → 都在（小写化后）  ✅ ✅
//    iterations      3 ≤ 6                                    ✅
//    stopReason      terminal_tool ≠ max_iterations_exceeded   ✅
//  → passed: true（8/8 全绿）
//
//  反面走查（假如模型这次幻觉了运单号）：
//    finalAnswer 说 "TRK-999…"，第 3 题的 mustNotContain ["TRK-"]
//    命中禁词 → 该小题 ❌ → 整题 passed: false，
//    成绩单上明确写着 `final answer must not contain "TRK-"`。
// ============================================================
