/**
 * Live runtime status tool.
 *
 * Exposes the main agent's current-running work view by combining in-memory
 * live run observability with durable task/cron ownership facts.
 */
import { type Static, Type } from "@sinclair/typebox";

import {
  buildCurrentRunningRuntimeStatus,
  buildRuntimeRunStatus,
} from "@/src/runtime/current-running-status.js";
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
          "Optional low-level run id to inspect. Omit this field to list all currently running work across the runtime, enriched with task/cron/background ownership metadata.",
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
      "Read the main agent's global current-running runtime status. By default it returns every currently running work item across agents, enriched with owner agent, task_run, background_task, and cron_job metadata when available. It also flags durable task/cron rows that still claim to be running without a matching live run. If runId is provided, it inspects that low-level live run and enriches it with the same ownership metadata when present.",
    inputSchema: GET_RUNTIME_STATUS_TOOL_SCHEMA,
    execute(context, args) {
      ensureMainAgentRuntimeCaller(context.sessionId, context.storage);

      if (context.runtimeControl?.getRuntimeStatus == null) {
        throw toolInternalError(
          "get_runtime_status is missing the host runtime control needed to read live runtime state.",
        );
      }

      const status = context.runtimeControl.getRuntimeStatus(
        args.runId == null ? undefined : { runId: args.runId },
      );
      if ("runs" in status) {
        return jsonToolResult(
          buildCurrentRunningRuntimeStatus({
            storage: context.storage,
            now: status.now,
            liveRuns: status.runs,
          }),
        );
      }
      if (status.found) {
        return jsonToolResult(
          buildRuntimeRunStatus({
            storage: context.storage,
            now: status.now,
            run: status.run,
          }),
        );
      }

      return jsonToolResult(status);
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
