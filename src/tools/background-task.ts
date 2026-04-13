import { type Static, Type } from "@sinclair/typebox";
import { AgentsRepo } from "@/src/storage/repos/agents.repo.js";
import { SessionsRepo } from "@/src/storage/repos/sessions.repo.js";
import { toolInternalError, toolRecoverableError } from "@/src/tools/core/errors.js";
import { defineTool, textToolResult } from "@/src/tools/core/types.js";

const BACKGROUND_CONTEXT_MODE_SCHEMA = Type.Union([
  Type.Literal("isolated"),
  Type.Literal("group"),
]);

export const BACKGROUND_TASK_TOOL_SCHEMA = Type.Object(
  {
    description: Type.String({
      minLength: 1,
      description: "Short label for this background task run.",
    }),
    task: Type.String({
      minLength: 1,
      description:
        "Concrete task instructions. Write enough detail so the task can run unattended and end by calling finish_task.",
    }),
    contextMode: Type.Optional(
      Type.Unsafe<Static<typeof BACKGROUND_CONTEXT_MODE_SCHEMA>>({
        ...BACKGROUND_CONTEXT_MODE_SCHEMA,
        default: "isolated",
        description:
          'Context mode for the task session. Use "isolated" by default. Use "group" only when this task truly needs current chat history.',
      }),
    ),
  },
  { additionalProperties: false },
);

export type BackgroundTaskToolArgs = Static<typeof BACKGROUND_TASK_TOOL_SCHEMA>;

export function createBackgroundTaskTool() {
  return defineTool({
    name: "background_task",
    description:
      "Start a one-shot unattended background task run. Use this only when the task can run independently without further user interaction. This call is non-blocking and returns immediately with a taskRunId.",
    inputSchema: BACKGROUND_TASK_TOOL_SCHEMA,
    async execute(context, args) {
      const description = args.description.trim();
      const task = args.task.trim();
      if (description.length === 0) {
        throw toolRecoverableError("background_task.description must not be empty.", {
          code: "background_task_empty_description",
        });
      }
      if (task.length === 0) {
        throw toolRecoverableError("background_task.task must not be empty.", {
          code: "background_task_empty_task",
        });
      }

      const sessionsRepo = new SessionsRepo(context.storage);
      const agentsRepo = new AgentsRepo(context.storage);
      const session = sessionsRepo.getById(context.sessionId);

      if (session == null) {
        throw toolInternalError(`Source session not found: ${context.sessionId}`);
      }
      if (session.purpose !== "chat") {
        throw toolRecoverableError("background_task is only available in chat sessions.", {
          code: "background_task_wrong_session_purpose",
          sessionPurpose: session.purpose,
        });
      }
      if (session.ownerAgentId == null) {
        throw toolRecoverableError("background_task requires a session owned by an agent.", {
          code: "background_task_missing_owner_agent",
          sessionId: context.sessionId,
        });
      }

      const ownerAgent = agentsRepo.getById(session.ownerAgentId);
      if (ownerAgent == null || (ownerAgent.kind !== "main" && ownerAgent.kind !== "sub")) {
        throw toolRecoverableError("background_task is only available to main/sub agents.", {
          code: "background_task_wrong_agent_kind",
          agentKind: ownerAgent?.kind ?? null,
        });
      }

      if (context.runtimeControl?.startBackgroundTask == null) {
        throw toolInternalError(
          "background_task is missing host runtime control to create the background task run.",
        );
      }

      const started = await context.runtimeControl.startBackgroundTask({
        sourceSessionId: context.sessionId,
        description,
        task,
        contextMode: args.contextMode ?? "isolated",
      });

      return textToolResult(
        [
          `Started background task "${description}".`,
          `Task run id: ${started.taskRunId}`,
          "This task now runs separately in background. Do not manually duplicate the same work in this run.",
        ].join("\n"),
        started,
      );
    },
  });
}
