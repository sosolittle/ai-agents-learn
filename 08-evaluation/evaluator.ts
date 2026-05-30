import type { AgentResult } from "./agent.js";
import type { EvalCase } from "./eval-cases.js";
import type { TraceEvent } from "./trace.js";

export interface EvalCheck {
  name: string;
  passed: boolean;
  message: string;
}

export interface EvalReport {
  caseName: string;
  passed: boolean;
  checks: EvalCheck[];
  finalAnswer: string;
}

function toolCalls(result: AgentResult, name: string): TraceEvent[] {
  return result.trace.filter(
    (event) => event.eventType === "tool_call" && event.toolName === name
  );
}

function containsExpectedArgs(
  actual: Record<string, unknown> | undefined,
  expected: Record<string, unknown>
): boolean {
  return Object.entries(expected).every(([key, value]) => actual?.[key] === value);
}

export function evaluateCase(testCase: EvalCase, result: AgentResult): EvalReport {
  const checks: EvalCheck[] = [];

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

  const maxIterations = testCase.maxIterations ?? 6;
  checks.push({
    name: "iteration limit",
    passed: result.iterations <= maxIterations,
    message:
      result.iterations <= maxIterations
        ? `finished in ${result.iterations}/${maxIterations} iterations`
        : `used ${result.iterations} iterations; maximum is ${maxIterations}`,
  });

  const acceptableStop = result.stopReason !== "max_iterations_exceeded";
  checks.push({
    name: "stop reason",
    passed: acceptableStop,
    message: acceptableStop
      ? `stopped with ${result.stopReason}`
      : "stopped because max iterations were exceeded",
  });

  return {
    caseName: testCase.name,
    passed: checks.every((check) => check.passed),
    checks,
    finalAnswer: result.finalAnswer,
  };
}
