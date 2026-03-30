import { type Static, Type } from "@sinclair/typebox";
import { SessionsRepo } from "@/src/storage/repos/sessions.repo.js";
import {
  TASK_COMPLETION_TOOL_NAME,
  type TaskCompletionDetails,
} from "@/src/tasks/task-completion.js";
import { toolInternalError, toolRecoverableError } from "@/src/tools/core/errors.js";
import { defineTool, textToolResult } from "@/src/tools/core/types.js";

const FINISH_TASK_STATUS_SCHEMA = Type.Union([
  Type.Literal("completed"),
  Type.Literal("blocked"),
  Type.Literal("failed"),
]);

export const FINISH_TASK_TOOL_SCHEMA = Type.Object(
  {
    status: FINISH_TASK_STATUS_SCHEMA,
    summary: Type.String({
      minLength: 1,
      description: "Short audit summary of the task outcome.",
    }),
    finalMessage: Type.String({
      minLength: 1,
      description:
        "Primary user-facing final result for this unattended task. This is shown on the task card.",
    }),
  },
  { additionalProperties: false },
);

export type FinishTaskToolArgs = Static<typeof FINISH_TASK_TOOL_SCHEMA>;

export function createFinishTaskTool() {
  return defineTool({
    name: TASK_COMPLETION_TOOL_NAME,
    description:
      "Mark an unattended task session as completed, blocked, or failed. Use this only in task sessions. Always include a short summary plus the full finalMessage that should appear on the task card. Calling this ends the current task run after the tool result is recorded.",
    inputSchema: FINISH_TASK_TOOL_SCHEMA,
    execute(context, args) {
      const session = new SessionsRepo(context.storage).getById(context.sessionId);
      if (session == null) {
        throw toolInternalError(`Task completion session not found: ${context.sessionId}`);
      }
      if (session.purpose !== "task") {
        throw toolRecoverableError("finish_task is only available in unattended task sessions.", {
          code: "finish_task_wrong_session_purpose",
          sessionId: context.sessionId,
          sessionPurpose: session.purpose,
        });
      }

      const details: TaskCompletionDetails = {
        taskCompletion: {
          status: args.status,
          summary: args.summary.trim(),
          finalMessage: args.finalMessage.trim(),
        },
      };

      return textToolResult(`Recorded task completion with status=${args.status}.`, details);
    },
  });
}
