import type { RunAgentLoopResult } from "@/src/agent/loop.js";
import type { CreatedTaskExecution } from "@/src/orchestration/task-run-factory.js";
import type { SettledTaskExecution } from "@/src/orchestration/task-run-lifecycle.js";
import type { SubmitMessageInput, SubmitMessageResult } from "@/src/runtime/ingress.js";
import { createSubsystemLogger } from "@/src/shared/logger.js";
import { buildTaskExecutionKickoffEnvelope } from "@/src/tasks/task-session.js";

const logger = createSubsystemLogger("tasks/runner");

export interface TaskExecutionRunnerIngress {
  submitMessage(input: SubmitMessageInput): Promise<SubmitMessageResult>;
}

export interface TaskExecutionRunnerLifecycle {
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
}

export type TaskExecutionRunResult =
  | {
      status: "completed";
      started: Extract<SubmitMessageResult, { status: "started" }>;
      settled: SettledTaskExecution;
      run: RunAgentLoopResult;
    }
  | {
      status: "failed" | "cancelled";
      settled: SettledTaskExecution;
      errorMessage: string;
    };

export class TaskExecutionRunner {
  constructor(private readonly deps: TaskExecutionRunnerDependencies) {}

  async runCreatedTaskExecution(input: {
    created: CreatedTaskExecution;
    createdAt?: Date;
  }): Promise<TaskExecutionRunResult> {
    const kickoff = buildTaskExecutionKickoffEnvelope(input.created.taskRun);
    const messageInput: SubmitMessageInput = {
      sessionId: input.created.executionSession.id,
      scenario: kickoff.scenario,
      content: kickoff.content,
      messageType: kickoff.messageType,
      visibility: kickoff.visibility,
      ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
    };

    logger.info("starting task execution", {
      taskRunId: input.created.taskRun.id,
      executionSessionId: input.created.executionSession.id,
      runType: input.created.taskRun.runType,
      ownerAgentId: input.created.taskRun.ownerAgentId,
      conversationId: input.created.taskRun.conversationId,
      branchId: input.created.taskRun.branchId,
      cronJobId: input.created.taskRun.cronJobId,
      parentRunId: input.created.taskRun.parentRunId,
    });

    logger.debug("submitting task execution kickoff message", {
      taskRunId: input.created.taskRun.id,
      executionSessionId: input.created.executionSession.id,
      scenario: messageInput.scenario,
      messageType: messageInput.messageType,
      visibility: messageInput.visibility,
      createdAt: input.createdAt?.toISOString(),
    });

    try {
      const started = await this.deps.ingress.submitMessage(messageInput);
      if (started.status !== "started") {
        const errorMessage =
          "Task execution session was already active before its kickoff message could start.";
        const settled = this.deps.lifecycle.failTaskExecution({
          taskRunId: input.created.taskRun.id,
          errorText: errorMessage,
          resultSummary: errorMessage,
        });

        logger.warn("task execution failed to start", {
          taskRunId: input.created.taskRun.id,
          executionSessionId: input.created.executionSession.id,
          reason: "session_already_active",
        });

        return {
          status: "failed",
          settled,
          errorMessage,
        };
      }

      logger.info("task execution kickoff accepted", {
        taskRunId: input.created.taskRun.id,
        executionSessionId: input.created.executionSession.id,
        runId: started.run.runId,
        scenario: started.run.scenario,
      });

      const settled = this.deps.lifecycle.completeTaskExecution({
        taskRunId: input.created.taskRun.id,
      });

      logger.info("task execution completed", {
        taskRunId: input.created.taskRun.id,
        executionSessionId: input.created.executionSession.id,
        runId: started.run.runId,
      });

      return {
        status: "completed",
        started,
        settled,
        run: started.run,
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
