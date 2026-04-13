import { type Static, Type } from "@sinclair/typebox";
import { AgentsRepo } from "@/src/storage/repos/agents.repo.js";
import { SessionsRepo } from "@/src/storage/repos/sessions.repo.js";
import { TaskRunsRepo } from "@/src/storage/repos/task-runs.repo.js";
import type { TaskRun } from "@/src/storage/schema/types.js";
import { parseBackgroundTaskPayload } from "@/src/tasks/background-task-payload.js";
import { toolInternalError, toolRecoverableError } from "@/src/tools/core/errors.js";
import { defineTool, type ToolExecutionContext, textToolResult } from "@/src/tools/core/types.js";

const DEFAULT_WAIT_TIMEOUT_SEC = 30;
const MAX_WAIT_TIMEOUT_SEC = 300;
const WAIT_POLL_INTERVAL_MS = 250;

export const WAIT_TASK_TOOL_SCHEMA = Type.Object(
  {
    taskRunId: Type.String({
      minLength: 1,
      description: "Background task run id returned by background_task.",
    }),
    timeoutSec: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: MAX_WAIT_TIMEOUT_SEC,
        default: DEFAULT_WAIT_TIMEOUT_SEC,
        description: `Maximum wait time in seconds. Default ${DEFAULT_WAIT_TIMEOUT_SEC}, max ${MAX_WAIT_TIMEOUT_SEC}.`,
      }),
    ),
  },
  { additionalProperties: false },
);

export type WaitTaskToolArgs = Static<typeof WAIT_TASK_TOOL_SCHEMA>;

export function createWaitTaskTool() {
  return defineTool({
    name: "wait_task",
    description:
      "Wait for a previously started background task to finish. Use this only when the current step is blocked on that task's result.",
    inputSchema: WAIT_TASK_TOOL_SCHEMA,
    getInvocationTimeoutMs(_context, args) {
      const timeoutSec = args.timeoutSec ?? DEFAULT_WAIT_TIMEOUT_SEC;
      return (timeoutSec + 2) * 1000;
    },
    async execute(context, args) {
      const caller = resolveWaitTaskCaller(context);
      if (caller.ownerAgent.kind !== "sub") {
        throw toolRecoverableError("wait_task is only available to subagents.", {
          code: "wait_task_not_subagent",
          agentKind: caller.ownerAgent.kind,
        });
      }

      const taskRunsRepo = new TaskRunsRepo(context.storage);
      let taskRun = taskRunsRepo.getById(args.taskRunId);
      if (taskRun == null) {
        throw toolRecoverableError(`Background task run not found: ${args.taskRunId}`, {
          code: "wait_task_not_found",
          taskRunId: args.taskRunId,
        });
      }

      if (taskRun.ownerAgentId !== caller.ownerAgent.id) {
        throw toolRecoverableError("You can only wait for background tasks owned by this agent.", {
          code: "wait_task_not_owned_by_caller",
          taskRunId: taskRun.id,
          ownerAgentId: taskRun.ownerAgentId,
        });
      }
      ensureWaitTaskTargetsCurrentSessionBackgroundTask(taskRun, context.sessionId);

      const timeoutSec = args.timeoutSec ?? DEFAULT_WAIT_TIMEOUT_SEC;
      const deadlineMs = Date.now() + timeoutSec * 1000;
      while (true) {
        taskRun = taskRunsRepo.getById(args.taskRunId);
        if (taskRun == null) {
          throw toolInternalError(`Task run disappeared while waiting: ${args.taskRunId}`);
        }

        if (isTerminalStatus(taskRun.status)) {
          context.runtimeControl?.suppressBackgroundTaskCompletionNotice?.({
            taskRunId: taskRun.id,
          });
          return textToolResult(renderTerminalTaskRunText(taskRun), {
            status: taskRun.status,
            taskRunId: taskRun.id,
            resultSummary: taskRun.resultSummary,
            errorText: taskRun.errorText,
            finishedAt: taskRun.finishedAt,
          });
        }

        if (Date.now() >= deadlineMs) {
          return textToolResult(
            `Task run ${taskRun.id} is still running after ${timeoutSec}s. Continue without waiting or call wait_task again later.`,
            {
              status: "still_running",
              taskRunId: taskRun.id,
            },
          );
        }

        await waitForMs(WAIT_POLL_INTERVAL_MS, context);
      }
    },
  });
}

function resolveWaitTaskCaller(context: ToolExecutionContext): {
  ownerAgent: { id: string; kind: string };
} {
  const sessionsRepo = new SessionsRepo(context.storage);
  const agentsRepo = new AgentsRepo(context.storage);
  const session = sessionsRepo.getById(context.sessionId);
  if (session == null) {
    throw toolInternalError(`Source session not found: ${context.sessionId}`);
  }
  if (session.purpose !== "chat") {
    throw toolRecoverableError("wait_task is only available in chat sessions.", {
      code: "wait_task_wrong_session_purpose",
      sessionPurpose: session.purpose,
    });
  }
  if (session.ownerAgentId == null) {
    throw toolRecoverableError("wait_task requires an owner agent.", {
      code: "wait_task_missing_owner_agent",
      sessionId: context.sessionId,
    });
  }

  const ownerAgent = agentsRepo.getById(session.ownerAgentId);
  if (ownerAgent == null) {
    throw toolInternalError(`Owner agent not found for wait_task session: ${session.ownerAgentId}`);
  }

  return {
    ownerAgent: {
      id: ownerAgent.id,
      kind: ownerAgent.kind,
    },
  };
}

function ensureWaitTaskTargetsCurrentSessionBackgroundTask(
  taskRun: TaskRun,
  sessionId: string,
): void {
  if (taskRun.runType !== "delegate" || parseBackgroundTaskPayload(taskRun.inputJson) == null) {
    throw toolRecoverableError(
      "wait_task only works for background_task runs started from this chat.",
      {
        code: "wait_task_not_background_task",
        taskRunId: taskRun.id,
        runType: taskRun.runType,
      },
    );
  }
  if (taskRun.initiatorSessionId !== sessionId) {
    throw toolRecoverableError(
      "You can only wait for background tasks started from this chat session.",
      {
        code: "wait_task_wrong_initiator_session",
        taskRunId: taskRun.id,
        initiatorSessionId: taskRun.initiatorSessionId,
      },
    );
  }
}

function waitForMs(ms: number, context: ToolExecutionContext): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    let done = false;
    const finishResolve = () => {
      if (done) {
        return;
      }
      done = true;
      if (context.abortSignal != null) {
        context.abortSignal.removeEventListener("abort", onAbort);
      }
      resolve();
    };
    const finishReject = () => {
      if (done) {
        return;
      }
      done = true;
      if (context.abortSignal != null) {
        context.abortSignal.removeEventListener("abort", onAbort);
      }
      reject(toolRecoverableError("wait_task was interrupted.", { code: "wait_task_interrupted" }));
    };
    const timer = setTimeout(finishResolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      finishReject();
    };

    if (context.abortSignal != null) {
      if (context.abortSignal.aborted) {
        clearTimeout(timer);
        finishReject();
        return;
      }
      context.abortSignal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function isTerminalStatus(status: string): boolean {
  return (
    status === "completed" || status === "blocked" || status === "failed" || status === "cancelled"
  );
}

function renderTerminalTaskRunText(taskRun: TaskRun): string {
  const lines = [
    `Task run ${taskRun.id} finished with status=${taskRun.status}.`,
    `Summary: ${taskRun.resultSummary ?? "(none)"}`,
  ];
  if (taskRun.errorText != null && taskRun.errorText.trim().length > 0) {
    lines.push(`Error: ${taskRun.errorText}`);
  }
  return lines.join("\n");
}
