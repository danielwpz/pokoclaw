import { type Static, Type } from "@sinclair/typebox";
import { AgentsRepo } from "@/src/storage/repos/agents.repo.js";
import { SessionsRepo } from "@/src/storage/repos/sessions.repo.js";
import { TaskRunsRepo } from "@/src/storage/repos/task-runs.repo.js";
import { parseBackgroundTaskPayload } from "@/src/tasks/background-task-payload.js";
import { toolInternalError, toolRecoverableError } from "@/src/tools/core/errors.js";
import { defineTool, jsonToolResult, type ToolExecutionContext } from "@/src/tools/core/types.js";

const BACKGROUND_TASK_STATUS_SCHEMA = Type.Union([
  Type.Literal("running"),
  Type.Literal("completed"),
  Type.Literal("blocked"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
  Type.Literal("all"),
]);

export const LIST_BACKGROUND_TASKS_TOOL_SCHEMA = Type.Object(
  {
    status: Type.Optional(
      Type.Unsafe<Static<typeof BACKGROUND_TASK_STATUS_SCHEMA>>({
        ...BACKGROUND_TASK_STATUS_SCHEMA,
        default: "running",
        description:
          'Filter by task status. Default "running". Use "all" to include settled tasks.',
      }),
    ),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 50,
        default: 20,
        description: "Maximum number of tasks to return.",
      }),
    ),
  },
  { additionalProperties: false },
);

export type ListBackgroundTasksToolArgs = Static<typeof LIST_BACKGROUND_TASKS_TOOL_SCHEMA>;

export function createListBackgroundTasksTool() {
  return defineTool({
    name: "list_background_tasks",
    description:
      "List background tasks started from the current chat session. Use this to inspect running work and recent settled results without opening a separate inspect tool.",
    inputSchema: LIST_BACKGROUND_TASKS_TOOL_SCHEMA,
    execute(context, args) {
      const caller = resolveBackgroundTaskCaller(context);
      const statusFilter = args.status ?? "running";
      const limit = args.limit ?? 20;
      const scanLimit = Math.min(300, Math.max(limit * 8, limit));
      const rows = new TaskRunsRepo(context.storage).listByOwner(caller.ownerAgent.id, scanLimit);

      const tasks = rows
        .flatMap((run) => {
          if (run.runType !== "delegate" || run.initiatorSessionId !== context.sessionId) {
            return [];
          }
          const payload = parseBackgroundTaskPayload(run.inputJson);
          if (payload == null || !matchesStatusFilter(run.status, statusFilter)) {
            return [];
          }

          return [
            {
              taskRunId: run.id,
              status: run.status,
              description: run.description,
              startedAt: run.startedAt,
              finishedAt: run.finishedAt,
              durationMs: run.durationMs,
              resultSummary: run.resultSummary,
              errorText: run.errorText,
              cancelledBy: run.cancelledBy,
              taskDefinitionPreview: truncateText(payload.taskDefinition, 240),
            },
          ];
        })
        .slice(0, limit);

      return jsonToolResult({
        statusFilter,
        tasks,
      });
    },
  });
}

function resolveBackgroundTaskCaller(context: ToolExecutionContext): {
  ownerAgent: { id: string; kind: string };
} {
  const sessionsRepo = new SessionsRepo(context.storage);
  const agentsRepo = new AgentsRepo(context.storage);
  const session = sessionsRepo.getById(context.sessionId);
  if (session == null) {
    throw toolInternalError(`Source session not found: ${context.sessionId}`);
  }
  if (session.purpose !== "chat") {
    throw toolRecoverableError("list_background_tasks is only available in chat sessions.", {
      code: "list_background_tasks_wrong_session_purpose",
      sessionPurpose: session.purpose,
    });
  }
  if (session.ownerAgentId == null) {
    throw toolRecoverableError("list_background_tasks requires an owner agent.", {
      code: "list_background_tasks_missing_owner_agent",
      sessionId: context.sessionId,
    });
  }

  const ownerAgent = agentsRepo.getById(session.ownerAgentId);
  if (ownerAgent == null) {
    throw toolInternalError(
      `Owner agent not found for list_background_tasks session: ${session.ownerAgentId}`,
    );
  }
  if (ownerAgent.kind !== "main" && ownerAgent.kind !== "sub") {
    throw toolRecoverableError("list_background_tasks is only available to main/sub agents.", {
      code: "list_background_tasks_wrong_agent_kind",
      agentKind: ownerAgent.kind,
    });
  }

  return {
    ownerAgent: {
      id: ownerAgent.id,
      kind: ownerAgent.kind,
    },
  };
}

function matchesStatusFilter(
  actualStatus: string,
  filter: "running" | "completed" | "blocked" | "failed" | "cancelled" | "all",
): boolean {
  if (filter === "all") {
    return true;
  }
  return actualStatus === filter;
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars - 3)}...`;
}
