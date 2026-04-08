import type { RunAgentLoopResult } from "@/src/agent/loop.js";
import type { CreatedTaskExecution } from "@/src/orchestration/task-run-factory.js";
import type { SettledTaskExecution } from "@/src/orchestration/task-run-lifecycle.js";
import type { SubmitMessageInput, SubmitMessageResult } from "@/src/runtime/ingress.js";
import { createSubsystemLogger } from "@/src/shared/logger.js";
import {
  extractTaskCompletionSignal,
  resolveTaskCompletionResultSummary,
  TASK_COMPLETION_TOOL_NAME,
  type TaskCompletionDetails,
  type TaskCompletionSignal,
} from "@/src/tasks/task-completion.js";
import {
  buildTaskExecutionKickoffEnvelope,
  buildTaskExecutionSupervisorReminderEnvelope,
} from "@/src/tasks/task-session.js";

const logger = createSubsystemLogger("tasks/runner");
const DEFAULT_MAX_SUPERVISOR_PASSES = 3;

export interface TaskExecutionRunnerIngress {
  submitMessage(input: SubmitMessageInput): Promise<SubmitMessageResult>;
}

export interface TaskExecutionRunnerLifecycle {
  blockTaskExecution(input: {
    taskRunId: string;
    resultSummary?: string | null;
    finishedAt?: Date;
  }): SettledTaskExecution;
  completeTaskExecution(input: {
    taskRunId: string;
    resultSummary?: string | null;
    finishedAt?: Date;
  }): SettledTaskExecution;
  failTaskExecution(input: {
    taskRunId: string;
    errorText?: string | null;
    resultSummary?: string | null;
    finishedAt?: Date;
  }): SettledTaskExecution;
  cancelTaskExecution(input: {
    taskRunId: string;
    cancelledBy: string;
    resultSummary?: string | null;
    finishedAt?: Date;
  }): SettledTaskExecution;
}

export interface TaskExecutionRunnerDependencies {
  ingress: TaskExecutionRunnerIngress;
  lifecycle: TaskExecutionRunnerLifecycle;
  maxSupervisorPasses?: number;
}

export type TaskExecutionRunResult =
  | {
      status: "completed" | "blocked";
      started: Extract<SubmitMessageResult, { status: "started" }>;
      settled: SettledTaskExecution;
      run: RunAgentLoopResult;
    }
  | {
      status: "failed";
      settled: SettledTaskExecution;
      errorMessage: string;
    }
  | {
      status: "cancelled";
      settled: SettledTaskExecution;
      errorMessage: string;
    };

export class TaskExecutionRunner {
  private readonly maxSupervisorPasses: number;

  constructor(private readonly deps: TaskExecutionRunnerDependencies) {
    this.maxSupervisorPasses = Math.max(
      1,
      deps.maxSupervisorPasses ?? DEFAULT_MAX_SUPERVISOR_PASSES,
    );
  }

  async runCreatedTaskExecution(input: {
    created: CreatedTaskExecution;
    createdAt?: Date;
  }): Promise<TaskExecutionRunResult> {
    logger.info("starting task execution", {
      taskRunId: input.created.taskRun.id,
      executionSessionId: input.created.executionSession.id,
      runType: input.created.taskRun.runType,
      ownerAgentId: input.created.taskRun.ownerAgentId,
      conversationId: input.created.taskRun.conversationId,
      branchId: input.created.taskRun.branchId,
      cronJobId: input.created.taskRun.cronJobId,
      parentRunId: input.created.taskRun.parentRunId,
      maxSupervisorPasses: this.maxSupervisorPasses,
    });

    try {
      for (let pass = 1; pass <= this.maxSupervisorPasses; pass += 1) {
        const started = await this.submitTaskPass({
          created: input.created,
          pass,
          ...(pass === 1 && input.createdAt !== undefined ? { createdAt: input.createdAt } : {}),
        });

        if (started.status === "failed") {
          return started;
        }

        logger.info("task execution pass finished", {
          taskRunId: input.created.taskRun.id,
          executionSessionId: input.created.executionSession.id,
          pass,
          runId: started.run.runId,
          stopSignalReason: started.run.stopSignal?.reason ?? null,
        });

        const completion = extractTaskCompletionFromRun(started.run);
        if (completion != null) {
          return this.settleTaskCompletion({
            taskRunId: input.created.taskRun.id,
            started,
            completion,
          });
        }

        if (pass < this.maxSupervisorPasses) {
          logger.warn("task execution pass ended without finish_task; continuing supervisor loop", {
            taskRunId: input.created.taskRun.id,
            executionSessionId: input.created.executionSession.id,
            pass,
            maxSupervisorPasses: this.maxSupervisorPasses,
          });
        }
      }

      const errorMessage = `Task execution ended without calling ${TASK_COMPLETION_TOOL_NAME} after ${this.maxSupervisorPasses} passes.`;
      const settled = this.deps.lifecycle.failTaskExecution({
        taskRunId: input.created.taskRun.id,
        errorText: errorMessage,
        resultSummary: errorMessage,
        finishedAt: new Date(),
      });

      logger.warn("task execution exhausted supervisor passes without explicit completion", {
        taskRunId: input.created.taskRun.id,
        executionSessionId: input.created.executionSession.id,
        maxSupervisorPasses: this.maxSupervisorPasses,
      });

      return {
        status: "failed",
        settled,
        errorMessage,
      };
    } catch (error) {
      const normalized = normalizeTaskExecutionError(error);
      const finishedAt = new Date();
      if (normalized.kind === "cancelled") {
        const settled = this.deps.lifecycle.cancelTaskExecution({
          taskRunId: input.created.taskRun.id,
          cancelledBy: normalized.cancelledBy,
          resultSummary: normalized.message,
          finishedAt,
        });

        logger.warn("task execution cancelled", {
          taskRunId: input.created.taskRun.id,
          executionSessionId: input.created.executionSession.id,
          error: normalized.message,
        });

        return {
          status: "cancelled",
          settled,
          errorMessage: normalized.message,
        };
      }

      const settled = this.deps.lifecycle.failTaskExecution({
        taskRunId: input.created.taskRun.id,
        errorText: normalized.message,
        resultSummary: "Task execution failed.",
        finishedAt,
      });

      logger.warn("task execution failed", {
        taskRunId: input.created.taskRun.id,
        executionSessionId: input.created.executionSession.id,
        error: normalized.message,
      });

      return {
        status: "failed",
        settled,
        errorMessage: normalized.message,
      };
    }
  }

  private async submitTaskPass(input: {
    created: CreatedTaskExecution;
    pass: number;
    createdAt?: Date;
  }): Promise<
    | Extract<SubmitMessageResult, { status: "started" }>
    | Extract<TaskExecutionRunResult, { status: "failed" }>
  > {
    const normalizedContextMode =
      input.created.executionSession.contextMode === "group"
        ? "group"
        : input.created.executionSession.contextMode === "isolated"
          ? "isolated"
          : null;

    const envelope =
      input.pass === 1
        ? buildTaskExecutionKickoffEnvelope(input.created.taskRun, {
            contextMode: normalizedContextMode,
          })
        : buildTaskExecutionSupervisorReminderEnvelope({
            runType: input.created.taskRun.runType,
            nextPass: input.pass,
            maxPasses: this.maxSupervisorPasses,
          });

    const messageInput: SubmitMessageInput = {
      sessionId: input.created.executionSession.id,
      scenario: envelope.scenario,
      content: envelope.content,
      messageType: envelope.messageType,
      visibility: envelope.visibility,
      afterToolResultHook: {
        afterToolResult: ({ toolCall, result }) => {
          const completion = extractTaskCompletionSignal({
            toolName: toolCall.name,
            result,
          });
          if (completion == null) {
            return { kind: "continue" };
          }

          return {
            kind: "stop_run",
            reason: "task_completion",
            payload: {
              taskCompletion: completion,
            } satisfies TaskCompletionDetails,
          };
        },
      },
      ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
    };

    logger.debug("submitting task execution message", {
      taskRunId: input.created.taskRun.id,
      executionSessionId: input.created.executionSession.id,
      pass: input.pass,
      scenario: messageInput.scenario,
      messageType: messageInput.messageType,
      visibility: messageInput.visibility,
      createdAt: input.createdAt?.toISOString(),
    });

    const started = await this.deps.ingress.submitMessage(messageInput);
    if (started.status === "started") {
      logger.info("task execution message accepted", {
        taskRunId: input.created.taskRun.id,
        executionSessionId: input.created.executionSession.id,
        pass: input.pass,
        runId: started.run.runId,
        scenario: started.run.scenario,
      });
      return started;
    }

    const errorMessage =
      "Task execution session was already active before its kickoff message could start.";
    const settled = this.deps.lifecycle.failTaskExecution({
      taskRunId: input.created.taskRun.id,
      errorText: errorMessage,
      resultSummary: errorMessage,
      finishedAt: new Date(),
    });

    logger.warn("task execution failed to start", {
      taskRunId: input.created.taskRun.id,
      executionSessionId: input.created.executionSession.id,
      pass: input.pass,
      reason: "session_already_active",
    });

    return {
      status: "failed",
      settled,
      errorMessage,
    };
  }

  private settleTaskCompletion(input: {
    taskRunId: string;
    started: Extract<SubmitMessageResult, { status: "started" }>;
    completion: TaskCompletionSignal;
  }):
    | Extract<TaskExecutionRunResult, { status: "completed" | "blocked" }>
    | Extract<TaskExecutionRunResult, { status: "failed" }> {
    const finishedAt = new Date();
    const resultSummary = resolveTaskCompletionResultSummary(input.completion);

    if (input.completion.status === "completed") {
      const settled = this.deps.lifecycle.completeTaskExecution({
        taskRunId: input.taskRunId,
        resultSummary,
        finishedAt,
      });
      return {
        status: "completed",
        started: input.started,
        settled,
        run: input.started.run,
      };
    }

    if (input.completion.status === "blocked") {
      const settled = this.deps.lifecycle.blockTaskExecution({
        taskRunId: input.taskRunId,
        resultSummary,
        finishedAt,
      });
      return {
        status: "blocked",
        started: input.started,
        settled,
        run: input.started.run,
      };
    }

    const settled = this.deps.lifecycle.failTaskExecution({
      taskRunId: input.taskRunId,
      errorText: input.completion.finalMessage,
      resultSummary,
      finishedAt,
    });
    return {
      status: "failed",
      settled,
      errorMessage: input.completion.finalMessage,
    };
  }
}

function extractTaskCompletionFromRun(run: RunAgentLoopResult): TaskCompletionSignal | null {
  return extractTaskCompletionSignal({
    details: run.stopSignal?.payload,
  });
}

function normalizeTaskExecutionError(
  error: unknown,
):
  | { kind: "cancelled"; message: string; cancelledBy: string }
  | { kind: "failed"; message: string } {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown error";
  const lower = message.toLowerCase();

  if (
    lower.includes("abort") ||
    lower.includes("cancelled") ||
    lower.includes("canceled") ||
    lower.includes("stop requested")
  ) {
    return {
      kind: "cancelled",
      message,
      cancelledBy: "system:task_runner",
    };
  }

  return {
    kind: "failed",
    message,
  };
}
