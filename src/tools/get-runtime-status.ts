/**
 * Live runtime status tool.
 *
 * Exposes the in-memory observability view for currently active runs so the
 * main agent can diagnose streaming progress, stalls, tool activity, and
 * approval waits. This intentionally complements, rather than replaces,
 * database and log inspection.
 */
import { type Static, Type } from "@sinclair/typebox";

import { AgentsRepo } from "@/src/storage/repos/agents.repo.js";
import { SessionsRepo } from "@/src/storage/repos/sessions.repo.js";
import { toolInternalError, toolRecoverableError } from "@/src/tools/core/errors.js";
import { defineTool, jsonToolResult } from "@/src/tools/core/types.js";

export const GET_RUNTIME_STATUS_TOOL_SCHEMA = Type.Object(
  {
    runId: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Optional run id to inspect. Omit this field to list all currently active runs in live memory. When runId is provided, the tool can also return a finished/failed/cancelled run snapshot if that run is still retained in memory.",
      }),
    ),
  },
  { additionalProperties: false },
);

export type GetRuntimeStatusToolArgs = Static<typeof GET_RUNTIME_STATUS_TOOL_SCHEMA>;

export function createGetRuntimeStatusTool() {
  // If you change the shape or semantics of this tool's returned live-status payload,
  // also update skills/system-observe/SKILL.md so agent-facing guidance stays accurate.
  return defineTool({
    name: "get_runtime_status",
    description:
      "Read live in-memory runtime status for main-agent diagnosis. By default it returns all currently active runs still present in live memory. If runId is provided, it returns that specific run when present, including a retained finished/failed/cancelled snapshot when still available in memory after the run leaves the active list. The payload separates run-level phase from latest-request status so a null latest-request TTFT only means the current request has not produced a first token yet, not that the whole run never responded.",
    inputSchema: GET_RUNTIME_STATUS_TOOL_SCHEMA,
    execute(context, args) {
      ensureMainAgentRuntimeCaller(context.sessionId, context.storage);

      if (context.runtimeControl?.getRuntimeStatus == null) {
        throw toolInternalError(
          "get_runtime_status is missing the host runtime control needed to read live runtime state.",
        );
      }

      return jsonToolResult(
        context.runtimeControl.getRuntimeStatus(
          args.runId == null ? undefined : { runId: args.runId },
        ),
      );
    },
  });
}

function ensureMainAgentRuntimeCaller(
  sessionId: string,
  storage: import("@/src/storage/db/client.js").StorageDb,
): void {
  const sessionsRepo = new SessionsRepo(storage);
  const agentsRepo = new AgentsRepo(storage);
  const session = sessionsRepo.getById(sessionId);

  if (session == null) {
    throw toolInternalError(`Source session not found: ${sessionId}`);
  }
  if (session.purpose !== "chat") {
    throw toolRecoverableError(
      "get_runtime_status is only available in the main-agent chat session.",
      {
        code: "get_runtime_status_wrong_session_purpose",
        sessionId,
        sessionPurpose: session.purpose,
      },
    );
  }
  if (session.ownerAgentId == null) {
    throw toolRecoverableError("get_runtime_status requires a session owned by the main agent.", {
      code: "get_runtime_status_missing_owner",
      sessionId,
    });
  }

  const ownerAgent = agentsRepo.getById(session.ownerAgentId);
  if (ownerAgent == null || ownerAgent.kind !== "main") {
    throw toolRecoverableError("get_runtime_status is only available to the main agent.", {
      code: "get_runtime_status_not_main_agent",
      ownerAgentId: session.ownerAgentId,
    });
  }
}
