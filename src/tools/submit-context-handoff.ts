import { type Static, Type } from "@sinclair/typebox";
import {
  CONTEXT_HANDOFF_TOOL_NAME,
  type ContextHandoffDetails,
} from "@/src/context-clear/handoff.js";
import { SessionsRepo } from "@/src/storage/repos/sessions.repo.js";
import { toolInternalError, toolRecoverableError } from "@/src/tools/core/errors.js";
import { defineTool, textToolResult } from "@/src/tools/core/types.js";

export const SUBMIT_CONTEXT_HANDOFF_TOOL_SCHEMA = Type.Object(
  {
    kickoffMessage: Type.String({
      minLength: 1,
      description:
        "The fresh context's internal kickoff message: current state, durable decisions, constraints, unresolved items, relevant files, and exact next steps.",
    }),
  },
  { additionalProperties: false },
);

export type SubmitContextHandoffToolArgs = Static<typeof SUBMIT_CONTEXT_HANDOFF_TOOL_SCHEMA>;

export function createSubmitContextHandoffTool() {
  return defineTool({
    name: CONTEXT_HANDOFF_TOOL_NAME,
    description:
      "Complete an internal context-clear handoff. The host uses kickoffMessage as the first hidden message in the fresh LLM context and then ends this handoff run.",
    inputSchema: SUBMIT_CONTEXT_HANDOFF_TOOL_SCHEMA,
    execute(context, args) {
      const session = new SessionsRepo(context.storage).getById(context.sessionId);
      if (session == null) {
        throw toolInternalError(`Context handoff session not found: ${context.sessionId}`);
      }
      if (session.purpose !== "context_handoff") {
        throw toolRecoverableError(
          "submit_context_handoff is only available in context handoff sessions.",
          {
            code: "context_handoff_wrong_session_purpose",
            sessionId: context.sessionId,
            sessionPurpose: session.purpose,
          },
        );
      }

      const details: ContextHandoffDetails = {
        contextHandoff: {
          kickoffMessage: args.kickoffMessage.trim(),
        },
      };
      return textToolResult("Context handoff recorded.", details);
    },
  });
}
