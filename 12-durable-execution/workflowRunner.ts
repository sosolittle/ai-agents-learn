// ============================================================
//  第十二章：工作流运行器（workflowRunner.ts）
//  编排、checkpoint 与恢复语义
//
//  学习目标：
//  1. 看懂"创建 → 运行 → 崩溃 → 恢复"四个动词各自的实现
//  2. 理解恢复点的唯一真相：completedSteps 推导，无 currentStep 指针
//  3. 掌握 checkpoint 时机：只在步骤完全成功之后，绝不提前
//  4. 区分三类"没跑完"：
//     崩溃（状态留 running）/ 业务失败（状态 failed）/ 幂等重放
//  5. 学习 SimulatedCrashError：如何用一个异常类型
//     精确扮演"进程消失"
//
//  本文件在整个章节中的角色：
//  它是唯一决定"顺序、checkpoint、从哪恢复"的文件。
//  每个步骤的实际工作住在 steps.ts；
//  本文件只是按序调用、在每个成功后持久化一个 checkpoint。
//  编排与动作分离——换一个业务流程，
//  steps.ts 换内容，本文件的骨架原样可用。
// ============================================================

import {
  findWorkflow,
  findWorkflowByApprovalId,
  nextWorkflowId,
  upsertWorkflow,
} from "./checkpointStore.js";
// checkpoint 存取 + 工作流启动幂等的查找（见 checkpointStore.ts）。
import type { DataPaths } from "./config.js";
import { appendEvent } from "./eventLog.js";
// 每个生命周期节点留事件。
import { mockConfirmationProvider, mockRefundProvider, validateApproval } from "./steps.js";
// 三步的实现。runner 只认这三个函数的签名，
// 不关心它们内部是不是 mock。
import {
  ApprovedActionSchema,
  WORKFLOW_STEPS,
  type ApprovedAction,
  type WorkflowContext,
  type WorkflowInput,
  type WorkflowRecord,
  type WorkflowStep,
} from "./types.js";
import { nowIso } from "./utils.js";

// 编排与恢复语义。这是唯一决定排序、checkpoint
// 和工作流从哪里恢复的文件。每个步骤的实际工作
// 住在 steps.ts；本文件只是按顺序调用它们，
// 并在每个步骤成功后持久化一个 checkpoint。

/**
 * 抛出它来模拟一次突然的进程崩溃（例如容器被杀、
 * 进程被 OOM 杀掉、机器断电）。它刻意不是业务失败：
 * 工作流记录原样保持在上次 checkpoint 的状态，
 * 调用方应该捕获它、打印崩溃、然后停下——
 * 而不是把任何东西标记为 failed。
 * 真实的崩溃永远没机会运行 catch 块；
 * 在这里抛出，只是给演示一个可控的停止点。
 */
export class SimulatedCrashError extends Error {
  // 自定义错误类的标准三件套：
  //   1. extends Error —— 继承标准错误（拿到 stack 等能力）
  //   2. super(消息)   —— 传给父类构造器
  //   3. this.name     —— 覆盖名字，打印时显示类名而不是笼统的 "Error"
  constructor(step: WorkflowStep) {
    // 构造器参数带上 step：错误消息能说清"崩在哪个步骤之后"。
    super(
      `Simulated process crash after the side effect for "${step}" succeeded, ` +
        "before the checkpoint for that step was saved."
      // 消息本身就是教学：读错误就知道崩溃点选在哪里、
      // 为什么选那里（副作用已成功 / checkpoint 未保存）。
    );
    this.name = "SimulatedCrashError";
  }
}
// "真实崩溃不会跑 catch"这句注释是理解的钥匙：
//   真实崩溃时：进程没了。任何 catch/finally/清理代码
//   都不会执行。磁盘上是崩溃前的最后状态。
//   模拟崩溃时：我们在正常代码里抛一个特殊异常。
//   它"像"崩溃的地方：调用方不能把它当业务错误处理
//   （不 markFailed、不重试），只能停下。
//   它"不像"崩溃的地方：异常处理机制还活着，
//   所以演示能打印漂亮的消息、进程能干净退出。
//   instanceof 检查（见 runStep 的 catch）保证两种
//   "没跑完"永远不会被混淆。

export interface RunnerOptions {
  /**
   * 在这个步骤的副作用成功之后、该步骤被 checkpoint 之前，
   * 立刻抛出 SimulatedCrashError。这正是整个模块
   * 要演示的危险窗口：外部副作用已经发生，
   * 但工作流还不知道。
   */
  crashAfterSideEffectStep?: WorkflowStep;
  // 可选注入点（dependency injection 的最小形态）：
  //   不传 → 正常运行（生产语义）
  //   传 "execute_refund" → 在退款后精确"断电"（演示语义）
  // 用参数注入而不是环境变量/全局开关：
  // 测试和演示可以逐次选择，互不干扰。
}

export interface RunResult {
  workflow: WorkflowRecord;
  // 跑完（或 no-op）后的最终记录。
  /** True 当工作流早已完成、什么都没跑的时候。 */
  noop?: boolean;
  // 恢复一条已完成的工作流时为 true：
  // "没有步骤运行、没有副作用、连事件都不发"。
  // 把"什么都没做"显式返回（而不是让调用方自己比较状态），
  // CLI 和测试都能直接消费。
}

function toWorkflowInput(approvedAction: ApprovedAction): WorkflowInput {
  // ApprovedAction（嵌套，对齐 11 章）→ WorkflowInput（扁平，供存储/步骤）。
  // 转换是纯搬字段，但"显式写出来"本身就是文档：
  // 两章接口的每一处字段映射都集中在这一个函数里。
  return {
    approvalId: approvedAction.approvalId,
    approvalStatus: approvedAction.status,
    toolName: approvedAction.toolName,
    orderId: approvedAction.arguments.orderId,
    amount: approvedAction.arguments.amount,
    currency: approvedAction.arguments.currency,
    reason: approvedAction.arguments.reason,
  };
}

export interface CreateWorkflowResult {
  workflow: WorkflowRecord;
  /** True 当返回的是这个审批已有的工作流，而不是新建的。 */
  reused: boolean;
}

/**
 * 从一个已批准的动作创建工作流，或返回已有的那个。
 *
 * 审批 ID 被当作已授权动作的业务身份——
 * 它与步骤级的幂等键（`WF-001:execute_refund`）
 * 是两个不同的边界：
 *
 *   - 审批身份 → 防止同一个审批启动第二个工作流
 *     （以及由此产生的第二个独立退款）。
 *   - 工作流-步骤身份 → 防止已有工作流的步骤重试
 *     重复该步骤的副作用。
 *
 * 没有这道守卫，重复提交 APR-001（例如重试的请求、
 * 第二次点击）会创建 WF-001 和 WF-002，
 * 而且每个都会有自己的 `WF-00N:execute_refund` 键——
 * 一笔审批换来两笔看起来都合法的退款。
 * 这个检查发生在分配新的工作流 ID 之前，
 * 所以重复提交甚至不会消耗一个 ID。
 *
 * 动作在这里做结构校验（形状对、原始类型对），
 * 但不做业务校验——那发生在 validate_approval
 * 步骤内部，每次运行都会做。
 */
export function createWorkflow(
  paths: DataPaths,
  rawApprovedAction: unknown
): CreateWorkflowResult {
  // 参数类型 unknown（不是 ApprovedAction）：
  // 与 11 章 handleProposal 同款纪律——边界函数不信调用方的类型声明，
  // 落盘/网络来的数据一律先过 Schema。
  const approvedAction = ApprovedActionSchema.parse(rawApprovedAction);
  // 结构校验：字段齐、类型对、无多余字段。
  // 注意它不会拒绝 status: "pending"——那是业务层的职责
  // （validate_approval 步骤），在运行时才会查。

  const existing = findWorkflowByApprovalId(paths, approvedAction.approvalId);
  // 幂等边界 A：这个审批已经有工作流了吗？
  if (existing) {
    return { workflow: existing, reused: true };
    // 有 → 原样返回 + reused: true。
    // 调用方（index.ts）打印"已存在，未新建、未退款"；
    // 调用方（测试）断言 reused 和 ID 相同。
    // 注意这里连 WORKFLOW_CREATED 事件都不发——
    // "没有创建"就不该有"创建事件"。
  }

  const id = nextWorkflowId(paths);
  // 只有确认没有既有工作流才分配新 ID（WF-001...）。
  const now = nowIso();

  const record: WorkflowRecord = {
    id,
    status: "running",
    // 新生工作流的状态：running（没有 "created" 这种状态——
    // 创建即视为开跑前的 running）。
    input: toWorkflowInput(approvedAction),
    // 扁平化的输入固化进记录：此后无论外部数据怎么变，
    // 这条工作流的输入永远可追溯。
    completedSteps: [],
    // 空前缀：一个步骤都没完成。
    // 合法（isValidCompletedPrefix 对空数组返回 true——
    // every 对空数组是 vacuously true）。
    context: {},
    createdAt: now,
    updatedAt: now,
  };

  upsertWorkflow(paths, record);
  // 第一个 checkpoint 其实就是"创建记录"本身：
  // 从这一刻起，工作流的存在是持久的事实。
  appendEvent(paths, { event: "WORKFLOW_CREATED", workflowId: id });
  return { workflow: record, reused: false };
}

/** 第一个不在 completedSteps 里的步骤。全部完成后为 undefined。 */
function nextIncompleteStep(record: WorkflowRecord): WorkflowStep | undefined {
  return WORKFLOW_STEPS.find((step) => !record.completedSteps.includes(step));
  // 恢复点的全部逻辑就这一行：
  //   按定义顺序找第一个未完成的步骤。
  //
  // 为什么这么简单？因为上游保证已经做了：
  //   1. completedSteps 必是有序前缀（superRefine 保证）——
  //      所以"第一个不在里面的"就是"下一个该跑的"
  //   2. WORKFLOW_STEPS 是唯一顺序真相（types.ts 保证）
  // 约束越强的数据，消费代码越短。
  // 这行代码的简洁是 Schema 层严格性换来的。
}

function requireWorkflow(paths: DataPaths, id: string): WorkflowRecord {
  // "按 ID 取记录，没有就抛可操作错误"的内部工具
  // （11 章 CLI requireId 的存储层版本）。
  const record = findWorkflow(paths, id);
  if (!record) {
    throw new Error(
      `No workflow found with id "${id}". Create one first with "npm start" or "npm run crash".`
    );
  }
  return record;
}

function checkpointStep(
  paths: DataPaths,
  record: WorkflowRecord,
  step: WorkflowStep,
  contextPatch: Partial<WorkflowContext>
): WorkflowRecord {
  // 参数 contextPatch: Partial<WorkflowContext>：
  //   Partial<T> 把所有字段变成可选——
  //   这一步产生的结果字段（refundId 或 confirmationId）。
  //   validate_approval 传 {}（它不产结果）。
  const updated: WorkflowRecord = {
    ...record,
    // 不可变更新（immutable update）的惯用写法：
    // 展开旧记录 + 覆盖要变的字段，产出新对象。
    // 旧对象保持原样（调用方可能还引用着它）。
    completedSteps: [...record.completedSteps, step],
    // 数组同样"复制后追加"——completedSteps 只增不改。
    context: { ...record.context, ...contextPatch },
    // context 增量合并：已有字段保留，新结果补进来。
    updatedAt: nowIso(),
  };
  // The checkpoint write. Everything before this point (side effects included)
  // could vanish with the process; everything after it is durable.
  // （在这一点之前的一切——包括副作用——都可能随进程消失；
  //  在这一点之后的一切都是持久的。）
  upsertWorkflow(paths, updated);
  appendEvent(paths, { event: "STEP_COMPLETED", workflowId: record.id, step });
  return updated;
  // 返回新记录让调用方（advance 的循环）继续用最新状态，
  // 避免"内存记录 vs 磁盘记录"两套真相。
}

function markCompleted(paths: DataPaths, record: WorkflowRecord): WorkflowRecord {
  // 全部步骤完成后的收尾：状态 → completed。
  // superRefine 保证"completed ⇒ 步骤全齐"，
  // 所以能走到这里就一定合法。
  const completed: WorkflowRecord = { ...record, status: "completed", updatedAt: nowIso() };
  upsertWorkflow(paths, completed);
  appendEvent(paths, { event: "WORKFLOW_COMPLETED", workflowId: record.id });
  return completed;
}

function markFailed(paths: DataPaths, record: WorkflowRecord, error: Error): void {
  // 一个真实的步骤错误（坏输入、不支持的币种……）是
  // 活着的进程才有机会记录的业务失败——
  // 与模拟崩溃不同，后者永远到不了这个函数。
  const failed: WorkflowRecord = {
    ...record,
    status: "failed",
    lastError: error.message,
    // 失败原因进记录：之后查状态的人不用翻日志就知道为何失败。
    updatedAt: nowIso(),
  };
  upsertWorkflow(paths, failed);
  // 注意这里不 appendEvent——STEP_FAILED 事件由 runStep
  // 的 catch 写（那里知道 step 上下文），职责不重复。
}

function runStep(
  paths: DataPaths,
  record: WorkflowRecord,
  step: WorkflowStep,
  options: RunnerOptions
): WorkflowRecord {
  // 单步执行 + 统一的错误分诊。这是"三类没跑完"
  // 的分岔口，也是本章最值得逐行读的函数。
  appendEvent(paths, { event: "STEP_STARTED", workflowId: record.id, step });
  // 先记"开始"：如果之后崩溃，时间线上会留下
  // "有 STARTED 无 COMPLETED"的缺口——崩溃的证据。

  try {
    switch (step) {
      // 按 step 分发。switch 收窄联合类型（同 11 章 runTool）。
      case "validate_approval": {
        // 纯的、无副作用：在它通过之前不可能有退款或确认。
        validateApproval(record.input);
        // 抛错 → 走下面的 catch → markFailed → 工作流 failed。
        // 通过 → 立即 checkpoint（无 contextPatch）。
        return checkpointStep(paths, record, step, {});
      }

      case "execute_refund": {
        // 副作用步骤一：退款。
        const { result, reused } = mockRefundProvider(paths, record.id, record.input);
        // 提供方内部已完成幂等检查：
        //   账本有 → 复用（reused: true）
        //   账本无 → 真实执行 + 记账（reused: false）
        // 无论哪种，result 都是有效的退款结果。
        appendEvent(paths, {
          event: reused ? "SIDE_EFFECT_REUSED" : "SIDE_EFFECT_EXECUTED",
          // 两种事件分开记录：
          //   EXECUTED = 这一次真的动了外部世界
          //   REUSED   = 幂等键命中，世界没被动
          // 时间线上能直接数出"真实副作用发生了几次"——
          // 最终验证"只退一次"的证据链。
          workflowId: record.id,
          step,
          metadata: { refundId: result.refundId, idempotencyKey: `${record.id}:${step}` },
          // metadata 带上幂等键本身：事后能对账
          // "这个键对应这条事件对应这个 REF 编号"。
        });

        // THE dangerous window: the refund provider has already created
        // REF-001. If the process dies right here, the checkpoint below never
        // runs, and the next call still sees execute_refund as incomplete.
        // （危险的窗口：退款提供方已经创建了 REF-001。
        //  如果进程恰好死在这里，下面的 checkpoint 永远不会执行，
        //  下一次调用仍然会把 execute_refund 视为未完成。）
        if (options.crashAfterSideEffectStep === step) {
          // 注入点命中 → 精确"断电"：
          //   副作用已落账本（上面 appendEffect 完成）
          //   checkpoint 尚未写入（checkpointStep 还没跑）
          // 这个 if 的位置就是整个模块存在的理由——
          // 把崩溃精确放在"checkpoint 无法覆盖的窗口"里。
          throw new SimulatedCrashError(step);
        }

        return checkpointStep(paths, record, step, { refundId: result.refundId });
        // 没有注入崩溃：正常 checkpoint。
        // 注意无论 reused 与否都写同一个 refundId——
        // 复用和真实执行对 checkpoint 而言没有区别
        // （步骤完成、结果已知）。
      }

      case "send_confirmation": {
        // 副作用步骤二：确认消息。结构与退款完全对称。
        const { result, reused } = mockConfirmationProvider(paths, record.id, record.input);
        appendEvent(paths, {
          event: reused ? "SIDE_EFFECT_REUSED" : "SIDE_EFFECT_EXECUTED",
          workflowId: record.id,
          step,
          metadata: {
            confirmationId: result.confirmationId,
            idempotencyKey: `${record.id}:${step}`,
          },
        });

        if (options.crashAfterSideEffectStep === step) {
          // 同款注入点（演示默认不用，但能力对称存在）。
          throw new SimulatedCrashError(step);
        }

        return checkpointStep(paths, record, step, { confirmationId: result.confirmationId });
      }

      default: {
        // 穷尽检查（11 章详解过 never 技巧）：
        // 漏写任何 case，这里编译报错。
        const exhaustive: never = step;
        throw new Error(`Unhandled workflow step: ${JSON.stringify(exhaustive)}`);
      }
    }
  } catch (error) {
    // 统一错误分诊：三类"没跑完"在这里分道扬镳。
    if (error instanceof SimulatedCrashError) {
      // Not a business failure — the workflow stays exactly at its last
      // checkpoint (status stays "running"). Let it propagate; the caller
      // decides what a crashed process does next (nothing, until it resumes).
      // （不是业务失败——工作流原样停在上次 checkpoint
      //  （状态保持 "running"）。让它继续向上冒泡；
      //  调用方决定崩溃的进程接下来做什么（什么都不做，直到恢复）。）
      throw error;
      // 关键区别：
      //   模拟崩溃 → 不 markFailed、不写 STEP_FAILED、
      //             状态保持 running、原样上抛
      //   为什么不标 failed？因为"崩溃"时进程不存在、
      //   无人标 failed——模拟要忠实于这一点。
      //   running + 缺口 = 崩溃现场的原貌。
    }
    const err = error as Error;
    appendEvent(paths, {
      event: "STEP_FAILED",
      workflowId: record.id,
      step,
      metadata: { error: err.message },
    });
    markFailed(paths, record, err);
    // 业务失败：进程活着，有能力也有责任记录失败。
    // 状态 → failed + lastError 落盘。
    // advance 会看到这个错误再次上抛（下面 throw err），
    // CLI 收到后打印并以非零码退出。
    throw err;
    // 业务失败也不静默：让调用链上层知道"这个工作流死了"。
  }
}

function advance(
  paths: DataPaths,
  workflowId: string,
  options: RunnerOptions,
  startEvent: "WORKFLOW_STARTED" | "WORKFLOW_RESUMED"
): RunResult {
  // runWorkflow 和 resumeWorkflow 的共同内核。
  // 唯一差别是起点事件的名字——首跑叫 STARTED，
  // 恢复叫 RESUMED（时间线上可区分两种"开始"）。
  const record = requireWorkflow(paths, workflowId);
  // 注意：record 是刚从磁盘读的。
  // 本函数不接收 WorkflowRecord 参数——
  // "恢复必须重读磁盘"是被签名强制的事实，
  // 不是靠开发者自觉。（对比：如果签名收 record，
  // 调用方就可能传内存里的旧对象。）

  if (record.status === "completed") {
    // Resuming a completed workflow must never repeat a side effect: it is a
    // pure no-op, and it is not even worth an event.
    // （恢复一条已完成的工作流绝不能重复副作用：
    //  它是纯 no-op，甚至不值得一发事件。）
    return { workflow: record, noop: true };
    // "连事件都不发"的考量：事件日志是事实记录——
    // "什么都没发生"如果也发事件，日志会随重复命令
    // 无限膨胀，而且和真实活动混在一起。
  }

  if (record.status === "failed") {
    // failed 是终态：不会自动重试。
    // 理由：业务失败（比如"金额为负"）重跑还是失败——
    // 自动重试只会刷屏。修复输入后创建新工作流。
    // （对比 running：它可能是崩溃残留，值得恢复。）
    throw new Error(
      `Workflow ${workflowId} previously failed and cannot be resumed automatically: ${record.lastError}. ` +
        "Fix the input and create a new workflow."
    );
  }

  appendEvent(paths, { event: startEvent, workflowId });

  // completedSteps——而不是单独追踪的 "currentStep" 指针——
  // 决定从哪里恢复。这样两者之间不存在可以失同步的东西。
  let current = record;
  // let：循环里每步都会被 checkpointStep 的返回值替换。
  // 变量名 current 表达"始终是最新 checkpoint 的镜像"。
  while (true) {
    // while(true) + 内部 break：跑完所有剩余步骤。
    // 不用 for...of WORKFLOW_STEPS：恢复时要从中间开始，
    // while + nextIncompleteStep 每轮动态询问更直接。
    const step = nextIncompleteStep(current);
    if (!step) {
      // 没有未完成步骤 → 收尾。
      current = markCompleted(paths, current);
      break;
    }
    current = runStep(paths, current, step, options);
    // 执行一步 → 拿到新 checkpoint → 循环。
    // 任何一步抛错（业务失败/模拟崩溃）都会冲出循环——
    // 循环体不做任何"吞错重试"：重试语义属于恢复方（人/新进程），
    // 不属于这个循环。
  }
  return { workflow: current };
}

/** 从第一个未完成的步骤起，运行一个新建的工作流。 */
export function runWorkflow(
  paths: DataPaths,
  workflowId: string,
  options: RunnerOptions = {}
): RunResult {
  // 默认参数 {}：不传 options = 不注入崩溃 = 正常语义。
  return advance(paths, workflowId, options, "WORKFLOW_STARTED");
}

/**
 * 重启后恢复一个工作流。每次调用都从磁盘重新加载记录
 * （经由 requireWorkflow -> findWorkflow）——没有任何
 * 从上一次运行带过来的内存工作流对象可复用。
 */
export function resumeWorkflow(
  paths: DataPaths,
  workflowId: string,
  options: RunnerOptions = {}
): RunResult {
  // run/resume 在实现上完全一样（同一个 advance）——
  // 差别只在事件名。这不是偷懒，是诚实：
  //   从数据的角度，"首次运行"和"崩溃后恢复"
  //   做的事一模一样：读 checkpoint → 跑剩余步骤。
  //   "恢复"没有任何特殊魔法，这正是 checkpoint 模式的美：
  //   恢复 = 普通的运行，只是从中间开始。
  //   Temporal 等框架的"重放"在思想上也是这一句。
  return advance(paths, workflowId, options, "WORKFLOW_RESUMED");
}

// ============================================================
//  本文件小结：全景图
// ============================================================
//
//  正常运行：
//    createWorkflow → runWorkflow
//      validate_approval ✓ → execute_refund ✓(新) → send_confirmation ✓ → completed
//
//  崩溃演示：
//    createWorkflow → runWorkflow{crash:execute_refund}
//      validate_approval ✓ → execute_refund 副作用已发生
//      💥 SimulatedCrashError（checkpoint 未写，状态仍 running）
//
//  恢复：
//    resumeWorkflow（另一个进程，重读磁盘）
//      → execute_refund 幂等命中(SIDE_EFFECT_REUSED) → checkpoint ✓
//      → send_confirmation ✓(新) → completed
//    最终账本：REF × 1，MSG × 1 —— 和不崩溃完全一致
//
//  三类"没跑完"的处理对照：
//  | 情形     | 状态    | 事件          | 重试语义        |
//  |----------|---------|---------------|-----------------|
//  | 崩溃     | running | 缺口（无事件）| 恢复可继续      |
//  | 业务失败 | failed  | STEP_FAILED   | 修输入建新工作流|
//  | 已完成   | completed| —            | no-op           |
// ============================================================
