import type { LarkRunState } from "@/src/channels/lark/run-state.js";

export interface LarkRenderedTaskCard {
  card: Record<string, unknown>;
  structureSignature: string;
}

export interface LarkTaskTerminalMessagePresentation {
  displayText: string | null;
  fullText: string | null;
  truncated: boolean;
}

export interface BuildLarkRenderedTaskCardOptions {
  title?: string | null;
}

export function buildLarkRenderedTaskCard(
  state: LarkRunState,
  options: BuildLarkRenderedTaskCardOptions = {},
): LarkRenderedTaskCard {
  const taskTitle = normalizeTaskTitle(options.title) ?? describeTaskRunKind(state.taskRunType);
  const card = {
    schema: "2.0",
    config: {
      update_multi: true,
      wide_screen_mode: false,
      summary: {
        content: summarizeTaskStatus(state, taskTitle),
      },
    },
    header: {
      title: {
        tag: "plain_text",
        content: taskTitle,
      },
      subtitle: {
        tag: "plain_text",
        content: `${describeTaskRunKind(state.taskRunType)}${describeTaskRunTerminal(state.terminal)}`,
      },
      template: describeTaskRunTemplate(state.terminal),
      icon: {
        tag: "standard_icon",
        token: describeTaskRunIcon(state.terminal),
      },
    },
    body: {
      elements: buildTaskCardElements(state),
    },
  };

  return {
    card,
    structureSignature: JSON.stringify(card),
  };
}

export function describeTaskRunKind(runType: string | null): string {
  if (runType === "cron") {
    return "定时任务";
  }
  if (runType === "system") {
    return "系统任务";
  }
  return "后台任务";
}

export function describeTaskRunTerminal(terminal: LarkRunState["terminal"]): string {
  if (terminal === "completed") {
    return "已完成";
  }
  if (terminal === "blocked") {
    return "已阻塞";
  }
  if (terminal === "failed") {
    return "失败";
  }
  if (terminal === "cancelled") {
    return "已停止";
  }
  if (terminal === "awaiting_approval") {
    return "等待授权";
  }
  if (terminal === "continued") {
    return "已获授权";
  }
  if (terminal === "denied") {
    return "已拒绝";
  }
  return "运行中";
}

export function describeTaskRunTemplate(terminal: LarkRunState["terminal"]): string {
  if (terminal === "completed" || terminal === "continued") {
    return "green";
  }
  if (terminal === "failed" || terminal === "cancelled" || terminal === "denied") {
    return "red";
  }
  if (terminal === "blocked") {
    return "grey";
  }
  return "blue";
}

export function describeTaskRunIcon(terminal: LarkRunState["terminal"]): string {
  if (terminal === "completed" || terminal === "continued") {
    return "yes_filled";
  }
  if (terminal === "cancelled" || terminal === "denied") {
    return "close_filled";
  }
  if (terminal === "failed" || terminal === "blocked") {
    return "warning_outlined";
  }
  if (terminal === "awaiting_approval") {
    return "lock_chat_filled";
  }
  return "robot_outlined";
}

function buildTaskCardElements(state: LarkRunState): Array<Record<string, unknown>> {
  const taskKind = describeTaskRunKind(state.taskRunType);
  const terminalMessage = getLarkTaskTerminalMessagePresentation(state.terminalMessage);

  if (state.terminal === "completed") {
    return [
      {
        tag: "markdown",
        content:
          terminalMessage.displayText == null
            ? `✅ ${taskKind}已完成`
            : terminalMessage.displayText,
      },
    ];
  }

  if (state.terminal === "blocked") {
    return [
      {
        tag: "markdown",
        content:
          terminalMessage.displayText == null ? `⏸ ${taskKind}已阻塞` : terminalMessage.displayText,
      },
    ];
  }

  if (state.terminal === "failed") {
    return [
      {
        tag: "markdown",
        content:
          terminalMessage.displayText == null
            ? `❌ ${taskKind}执行失败`
            : terminalMessage.displayText,
      },
    ];
  }

  if (state.terminal === "cancelled") {
    return [
      {
        tag: "markdown",
        content:
          terminalMessage.displayText == null ? `⏹ ${taskKind}已停止` : terminalMessage.displayText,
      },
    ];
  }

  if (state.terminal === "awaiting_approval") {
    return [
      {
        tag: "markdown",
        content: `🔐 ${taskKind}等待授权`,
      },
    ];
  }

  if (state.terminal === "continued") {
    return [
      {
        tag: "markdown",
        content: `✅ ${taskKind}已恢复执行`,
      },
    ];
  }

  if (state.terminal === "denied") {
    return [
      {
        tag: "markdown",
        content: `❌ ${taskKind}授权被拒绝`,
      },
    ];
  }

  return [
    {
      tag: "markdown",
      content: `⏳ ${taskKind}正在运行`,
    },
  ];
}

function summarizeTaskStatus(state: LarkRunState, taskTitle: string): string {
  if (state.terminal === "completed") {
    return `${taskTitle}已完成`;
  }
  if (state.terminal === "blocked") {
    return `${taskTitle}已阻塞`;
  }
  if (state.terminal === "failed") {
    return `${taskTitle}失败`;
  }
  if (state.terminal === "cancelled") {
    return `${taskTitle}已停止`;
  }
  if (state.terminal === "awaiting_approval") {
    return `${taskTitle}等待授权`;
  }
  if (state.terminal === "continued") {
    return `${taskTitle}已恢复执行`;
  }
  if (state.terminal === "denied") {
    return `${taskTitle}已拒绝`;
  }
  return `${taskTitle}运行中`;
}

export function getLarkTaskTerminalMessagePresentation(
  message: string | null,
): LarkTaskTerminalMessagePresentation {
  if (message == null) {
    return {
      displayText: null,
      fullText: null,
      truncated: false,
    };
  }
  const trimmed = message.trim();
  if (trimmed.length === 0) {
    return {
      displayText: null,
      fullText: null,
      truncated: false,
    };
  }
  if (trimmed.length <= 1600) {
    return {
      displayText: trimmed,
      fullText: trimmed,
      truncated: false,
    };
  }
  return {
    displayText: `${trimmed.slice(0, 1597)}...`,
    fullText: trimmed,
    truncated: true,
  };
}

function normalizeTaskTitle(title: string | null | undefined): string | null {
  if (title == null) {
    return null;
  }
  const trimmed = title.trim();
  if (trimmed.length === 0) {
    return null;
  }
  return trimmed.length <= 120 ? trimmed : `${trimmed.slice(0, 117)}...`;
}
