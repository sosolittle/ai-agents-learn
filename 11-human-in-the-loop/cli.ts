// ============================================================
//  第十一章：审批 CLI（cli.ts）
//  在不同进程中恢复并推进人工审批
//
//  学习目标：
//  1. 用 list / edit / approve / reject 操作持久化审批单
//  2. 理解 CLI 只是输入适配层，所有业务规则仍在 approvalService
//     —— 命令解析在这里结束，规则判断从这里开始
//  3. 观察人工审批不是阻塞式 readline，而是可暂停、可恢复的工作流
//  4. 通过 audit 命令查看完整生命周期
//  5. 学一个零依赖的迷你命令行解析器怎么写
//
//  本文件在整个章节中的角色：
//  它是"审批人"。npm start 负责创建 pending 单（提案进程），
//  本文件负责让人类在任何时候、任何进程里审阅并推进它（审批进程）。
//  两个进程通过 data/ 下的 JSON 文件接力——这就是"暂停-恢复"
//  的物 理形态。
//
//  命令一览（package.json 的 scripts 逐条对应）：
//    npm run approvals                     → list
//    npm run edit -- APR-001 --amount=49   → edit
//    npm run approve -- APR-001            → approve
//    npm run reject -- APR-001 --reason=.. → reject
//    npm run audit                         → audit
//    npm run reset                         → reset
// ============================================================

import {
  approveApproval,
  editApproval,
  rejectApproval,
  resetDemo,
} from "./approvalService.js";
// 四个生命周期操作 + 演示重置，全部是 service 层函数。
// CLI 里没有一行业务规则——它是纯粹的"翻译官"：
// 把命令行参数翻译成函数调用，把返回值翻译成人类可读输出。
import { loadApprovals } from "./approvalStore.js";
import { loadAudit } from "./auditLog.js";
import { defaultPaths } from "./config.js";
import { prettyJson, printSection } from "./utils.js";

// 一个盖在审批生命周期上的小型命令行接口。每个 npm script
// 对应一个子命令：list, edit, approve, reject, audit, reset。
// 提案那一步本身住在 index.ts（npm start）里，
// 因为那是唯一调用模型的部分。

interface ParsedArgs {
  // 命令行参数解析结果的形状。
  positionals: string[];
  // 位置参数：不带 -- 前缀的裸词，如 ["APR-001"]。
  flags: Record<string, string>;
  // 具名参数：--amount=49 → { amount: "49" }。
  // 值统一是字符串，类型转换交给 service 层（coerceNumber）。
}

/** 把 "APR-001 --amount=49 --reason=Text" 和 "--reason Text" 解析成参数。 */
function parseArgs(argv: string[]): ParsedArgs {
  // 一个 ~20 行的迷你解析器，支持三种形态：
  //   --key=value   → flags[key] = value
  //   --key value   → flags[key] = value（值不能以 -- 开头）
  //   --key         → flags[key] = "true"（布尔旗标）
  // 为什么不用 commander/yargs？教学模块尽量零依赖，
  // 而且亲手写一遍能看清"参数从字符串到结构"的全过程。
  const positionals: string[] = [];
  const flags: Record<string, string> = {};

  for (let i = 0; i < argv.length; i++) {
    // 手写索引进循环：--key value 形态需要"吃掉两个词"，
    // 内层要移动 i，forEach 做不到（它的回调改不了外部游标）。
    const token = argv[i];
    if (token.startsWith("--")) {
      // 以 -- 开头 → 具名参数。
      // 同时支持 --amount=49 与 --amount 49。
      // 所有 flag 先保留为字符串，字段保护、类型转换和 Schema 校验交给 service。
      //
      // "CLI 层不做校验"是刻意的分层：
      //   校验规则若散落在解析层和业务层两处，
      //   改规则时总要记得改两个地方。集中在 service（Schema），
      //   CLI 永远只做"无脑透传"。
      const body = token.slice(2);
      // 去掉前缀 "--"："--amount=49" → "amount=49"。
      const eq = body.indexOf("=");
      // 找 "=" 的位置，区分 key=value 和裸 key 两种形态。
      if (eq !== -1) {
        // 形态一：--key=value
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        // slice 两刀：[0,eq) 是键，(eq,末尾] 是值。
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        // 形态二：--key value
        // 条件：下一个词存在、且不是另一个 flag。
        flags[body] = argv[++i];
        // ++i（前缀自增）：先把 i 前移再取值——
        // 下一个词被本 flag 消费，外层循环不会再处理它。
      } else {
        // 形态三：--key（后面没有值，或后面还是 flag）
        flags[body] = "true";
        // 布尔旗标用字符串 "true" 占位。
        // 本模块没用到这种形态，但解析器写全了方便扩展。
      }
    } else {
      positionals.push(token);
      // 不以 -- 开头 → 位置参数（比如审批单 ID）。
    }
  }

  return { positionals, flags };
}

function requireId(positionals: string[], command: string): string {
  // "取第一个位置参数当 ID，没有就报用法错误"的小工具。
  // 每个需要 ID 的子命令开头都调它，错误消息统一带用法示例。
  const id = positionals[0];
  if (!id) {
    throw new Error(`Missing approval id. Usage: npm run ${command} -- APR-001`);
  }
  return id;
}

function main(): void {
  const paths = defaultPaths();
  // npm run approve -- APR-001 最终会形成：
  // process.argv.slice(2) === ["approve", "APR-001"]。
  //
  // process.argv 的结构：
  //   [0] node 可执行文件路径
  //   [1] 被执行脚本的路径
  //   [2...] 传给脚本的参数
  // npm run x -- y 里的 -- 是"后面是给脚本的参数"的分隔符，
  // npm 会把 y 原样透传。
  const [command, ...rest] = process.argv.slice(2);
  // 解构 + 收集-rest：第一个词是子命令，剩下的交给 parseArgs。
  // command 的类型是 string | undefined（argv 可能是空的）——
  // 下面的 default 分支处理 undefined 的情况。
  const { positionals, flags } = parseArgs(rest);

  switch (command) {
    case "list": {
      // list 只读取持久化记录，不调用模型，也不改变审批状态。
      // 纯只读命令：不开模型、不改文件，随时可跑。
      const approvals = loadApprovals(paths);
      printSection("Approvals");
      if (approvals.length === 0) {
        console.log("No approvals yet. Create one with \"npm start\".");
        // 空状态也要给出下一步指引——
        // "下一步做什么"是 CLI 可用性的一半。
        break;
      }
      for (const record of approvals) {
        const args = prettyJson(record.proposedAction.arguments).replace(/\n/g, "\n    ");
        // 参数 JSON 的换行统一再缩进 4 格，
        // 让多行参数对齐到单据信息下面，列表不乱。
        console.log(
          `- ${record.id}  [${record.status}]  ${record.proposedAction.toolName}` +
            (record.executionId ? `  → ${record.executionId}` : "") +
            `\n    ${args}`
        );
        // 一行单据的格式：
        //   - APR-001  [executed]  refundOrder  → EXE-001
        //       { ...参数... }
        // 已执行的单显示 → EXE-xxx 链接，肉眼可追。
      }
      break;
    }

    case "edit": {
      const id = requireId(positionals, "edit");
      // 所有 flag 都作为参数编辑透传；service 会拒绝任何
      // 受保护字段，并重新校验合并后的参数。
      //
      // 注意 CLI 层没有 --amount 的白名单：
      // 命令行来什么就传什么（--status=executed 也传），
      // 由 service 的 PROTECTED_EDIT_FIELDS 和 Schema 拒绝。
      // 守门员只有一个，规则只有一份。
      const { before, after } = editApproval(paths, id, flags);
      // CLI 展示 before/after，让审核人确认实际写入的参数变化。
      printSection(`Edited ${id}`);
      console.log("Before:");
      console.log(prettyJson(before));
      console.log("\nAfter:");
      console.log(prettyJson(after));
      console.log("\nStill pending. Re-validated. Nothing has executed yet.");
      // 结尾再次强调状态：还是 pending、已复验、未执行。
      // 每个命令结束都说清"世界现在的样子"，
      // 用户不需要记住状态机。
      break;
    }

    case "approve": {
      const id = requireId(positionals, "approve");
      const outcome = approveApproval(paths, id);
      // blocked 与 recovered 都不会再次调用工具：
      // blocked 表示审批单已经是 executed；
      // recovered 表示执行记录存在，但审批状态需要补齐。
      //
      // 三种结局对应三段文案，每段都明说"工具没有再被调用"：
      if (outcome.blocked) {
        // 结局 1：重复批准已执行的单。
        printSection(`Approve ${id}`);
        console.log(
          `Already executed as ${outcome.record.executionId}. ` +
            "Duplicate execution blocked — the tool was not called again."
        );
        break;
      }
      if (outcome.execution?.recovered) {
        // 结局 2：崩溃恢复——execution 已存在，状态补齐为 executed。
        // ?. 可选链：execution 可能是 undefined（blocked 场景），
        // 上面已经 break，这里其实必有值，但类型系统不知道，链一下最稳。
        printSection(`Approve ${id}`);
        console.log(
          `An execution already existed for this approval (${outcome.execution.executionId}). ` +
            "Reused it — the tool was not called again. Record reconciled to executed."
        );
        console.log(prettyJson(outcome.execution.result));
        break;
      }
      // 结局 3：正常路径——本次批准触发了一次全新执行。
      printSection(`Approved ${id}`);
      console.log(`Executed as ${outcome.execution?.executionId}. Mock result:`);
      console.log(prettyJson(outcome.execution?.result));
      break;
    }

    case "reject": {
      const id = requireId(positionals, "reject");
      const reason = flags.reason ?? "";
      // reject 的理由从 flag 取；空串会被 service 拒绝
      // （拒绝必须给理由，见 approvalService.rejectApproval）。
      const record = rejectApproval(paths, id, reason);
      printSection(`Rejected ${id}`);
      console.log(`Reason: ${record.decisionReason}`);
      console.log("The tool was not executed and cannot be approved.");
      // 再次强调终态语义：拒绝了就永远不能批这张单了。
      break;
    }

    case "audit": {
      // 审计命令输出追加式事件时间线；它不根据当前 approval 状态反推历史。
      const events = loadAudit(paths);
      printSection("Audit log");
      if (events.length === 0) {
        console.log("No audit events yet.");
        break;
      }
      for (const event of events) {
        const suffix = [
          event.approvalId ? `approval=${event.approvalId}` : "",
          event.toolName ? `tool=${event.toolName}` : "",
        ]
          .filter(Boolean)
          // filter(Boolean)：去掉两个空串，
          // 只留下实际存在的标注（小技巧：空串是假值）。
          .join(" ");
        console.log(`- ${event.timestamp}  ${event.event}${suffix ? `  (${suffix})` : ""}`);
        // 输出形态：
        //   - 2026-08-18T...Z  ACTION_APPROVED  (approval=APR-001 tool=refundOrder)
        // 时间 + 事件 + 关联对象，一行一个事实。
      }
      break;
    }

    case "reset": {
      resetDemo(paths);
      printSection("Reset");
      console.log("Cleared approvals, executions, and the audit log to a clean demo state.");
      break;
    }

    default:
      // command 不匹配任何 case（包括 undefined——什么都没传）。
      console.error(
        `Unknown command: ${command ?? "(none)"}\n` +
          "Available: list, edit, approve, reject, audit, reset."
      );
      // ?? "(none)"：把"没给命令"也翻译成人话。
      process.exitCode = 1;
      // 未知命令是非零退出码——脚本调用方能感知失败。
  }
}

try {
  main();
} catch (error) {
  // CLI 将 service 的明确错误转成非零退出码，方便脚本或 CI 判断操作失败。
  //
  // 所有 service 抛出的业务错误（找不到单、不能编辑、校验失败）
  // 都在这里统一收口：打印消息 + 退出码 1。
  // "错误消息给人看，退出码给机器看"——两者都要。
  console.error(`\nError: ${(error as Error).message}`);
  process.exitCode = 1;
}

// ============================================================
//  本文件小结：CLI 的三条纪律
// ============================================================
//
// 1. CLI 只是适配层。
//    解析参数 → 调 service → 打印结果。没有一行业务规则，
//    所以规则改动永远只动 service（和它的测试）。
//
// 2. 每个命令结束都报告真实状态。
//    "Still pending"、"tool was not called again"、
//    "cannot be approved"——用户不需要脑补状态机。
//
// 3. 错误给人 + 退出码给机器。
//    人读 Error: 消息，脚本读非零 exit code。
//
// 跨进程接力全景：
//   进程 A（npm start）   ：提案 + 创建 pending + 退出
//   进程 B（npm run edit） : 改参数 + 复验 + 退出
//   进程 C（npm run approve): 批准 + 执行一次 + 退出
//   进程 D（npm run audit） : 只读时间线
// 四个进程，一份 JSON 状态，无服务器、无常驻进程。
// ============================================================
