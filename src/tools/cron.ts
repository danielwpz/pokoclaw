import { randomUUID } from "node:crypto";
import { type Static, Type } from "@sinclair/typebox";

import { resolveInitialNextRunAt } from "@/src/cron/schedule.js";
import type { StorageDb } from "@/src/storage/db/client.js";
import { AgentsRepo } from "@/src/storage/repos/agents.repo.js";
import { ConversationBranchesRepo } from "@/src/storage/repos/conversation-branches.repo.js";
import { CronJobsRepo } from "@/src/storage/repos/cron-jobs.repo.js";
import { SessionsRepo } from "@/src/storage/repos/sessions.repo.js";
import type { CronJob } from "@/src/storage/schema/types.js";
import { toolInternalError, toolRecoverableError } from "@/src/tools/core/errors.js";
import { defineTool, jsonToolResult, textToolResult } from "@/src/tools/core/types.js";

const CRON_ACTION_SCHEMA = Type.Union([
  Type.Literal("list"),
  Type.Literal("add"),
  Type.Literal("update"),
  Type.Literal("remove"),
  Type.Literal("run"),
  Type.Literal("pause"),
  Type.Literal("resume"),
]);

const CRON_SCHEDULE_KIND_SCHEMA = Type.Union([
  Type.Literal("at"),
  Type.Literal("every"),
  Type.Literal("cron"),
]);

export const CRON_TOOL_SCHEMA = Type.Object(
  {
    action: CRON_ACTION_SCHEMA,
    jobId: Type.Optional(Type.String({ minLength: 1 })),
    includeDisabled: Type.Optional(Type.Boolean()),
    name: Type.Optional(Type.String({ minLength: 1 })),
    scheduleKind: Type.Optional(CRON_SCHEDULE_KIND_SCHEMA),
    scheduleValue: Type.Optional(Type.String({ minLength: 1 })),
    timezone: Type.Optional(Type.String({ minLength: 1 })),
    prompt: Type.Optional(Type.String({ minLength: 1 })),
    enabled: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export type CronToolArgs = Static<typeof CRON_TOOL_SCHEMA>;

export function createCronTool() {
  return defineTool({
    name: "cron",
    description:
      "Create, inspect, update, pause, resume, remove, and manually run scheduled cron jobs that belong to the current agent context.",
    inputSchema: CRON_TOOL_SCHEMA,
    async execute(context, args) {
      const resolved = resolveCronCaller(context);
      const repo = new CronJobsRepo(context.storage);

      switch (args.action) {
        case "list": {
          const jobs = repo
            .list({
              ownerAgentIds: resolved.manageableOwnerIds,
              includeDisabled: args.includeDisabled ?? false,
              limit: 100,
            })
            .map(formatCronJobForOutput);
          return jsonToolResult({ jobs });
        }

        case "add": {
          const prompt = requireField(args.prompt, "prompt");
          const scheduleKind = requireScheduleKind(args.scheduleKind);
          const scheduleValue = requireField(args.scheduleValue, "scheduleValue");
          const now = new Date();
          const nextRunAt = resolveInitialNextRunAt(
            {
              scheduleKind,
              scheduleValue,
              timezone: args.timezone,
            },
            now,
          );

          const created = repo.create({
            id: randomUUID(),
            ownerAgentId: resolved.callerAgent.id,
            targetConversationId: resolved.callerAgent.conversationId,
            targetBranchId: resolved.homeBranchId,
            name: args.name ?? null,
            scheduleKind,
            scheduleValue,
            timezone: args.timezone ?? null,
            enabled: args.enabled ?? true,
            contextMode: resolved.callerAgent.kind === "sub" ? "group" : "isolated",
            payloadJson: JSON.stringify({ prompt }),
            nextRunAt: (args.enabled ?? true) ? nextRunAt : null,
            createdAt: now,
            updatedAt: now,
          });

          return textToolResult(
            `Created cron job "${created.name ?? created.id}" for this ${resolved.callerAgent.kind === "main" ? "main agent" : "subagent"}.`,
            formatCronJobForOutput(created),
          );
        }

        case "update": {
          const job = requireOwnedJob(repo, args.jobId, resolved.callerAgent.id);
          const patch = buildUpdatePatch(job, args);
          const updated = repo.update({
            id: job.id,
            ...patch,
            updatedAt: new Date(),
          });
          if (updated == null) {
            throw toolInternalError(`Cron job ${job.id} disappeared during update.`);
          }
          return textToolResult(
            `Updated cron job "${updated.name ?? updated.id}".`,
            formatCronJobForOutput(updated),
          );
        }

        case "remove": {
          const job = requireOwnedJob(repo, args.jobId, resolved.callerAgent.id);
          repo.remove(job.id);
          return textToolResult(`Removed cron job "${job.name ?? job.id}".`, {
            id: job.id,
          });
        }

        case "pause":
        case "resume": {
          const job = requireManageableJob(repo, args.jobId, resolved.manageableOwnerIds);
          const updated = repo.update({
            id: job.id,
            enabled: args.action === "resume",
            updatedAt: new Date(),
            ...(args.action === "resume"
              ? {
                  nextRunAt: resolveInitialNextRunAt(
                    {
                      scheduleKind: job.scheduleKind as "at" | "every" | "cron",
                      scheduleValue: job.scheduleValue,
                      timezone: job.timezone,
                    },
                    new Date(),
                  ),
                }
              : { nextRunAt: null }),
          });
          if (updated == null) {
            throw toolInternalError(`Cron job ${job.id} disappeared during ${args.action}.`);
          }
          return textToolResult(
            `${args.action === "pause" ? "Paused" : "Resumed"} cron job "${updated.name ?? updated.id}".`,
            formatCronJobForOutput(updated),
          );
        }

        case "run": {
          const job = requireManageableJob(repo, args.jobId, resolved.manageableOwnerIds);
          if (context.runtimeControl?.runCronJobNow == null) {
            throw toolInternalError("cron.run is missing host runtime control.");
          }
          const result = await context.runtimeControl.runCronJobNow({ jobId: job.id });
          return textToolResult(`Triggered cron job "${job.name ?? job.id}" to run now.`, result);
        }
      }
    },
  });
}

function resolveCronCaller(context: { sessionId: string; storage: StorageDb }) {
  const sessionsRepo = new SessionsRepo(context.storage);
  const agentsRepo = new AgentsRepo(context.storage);
  const branchesRepo = new ConversationBranchesRepo(context.storage);

  const session = sessionsRepo.getById(context.sessionId);
  if (session == null) {
    throw toolInternalError(`Source session not found: ${context.sessionId}`);
  }
  if (session.purpose !== "chat") {
    throw toolRecoverableError("cron is only available in agent chat sessions.", {
      code: "cron_wrong_session_purpose",
      sessionPurpose: session.purpose,
    });
  }
  if (session.ownerAgentId == null) {
    throw toolRecoverableError("cron is missing its owner agent context.", {
      code: "cron_missing_owner_agent",
      sessionId: context.sessionId,
    });
  }

  const callerAgent = agentsRepo.getById(session.ownerAgentId);
  if (callerAgent == null || (callerAgent.kind !== "main" && callerAgent.kind !== "sub")) {
    throw toolRecoverableError("cron is only available to the main agent or a subagent.", {
      code: "cron_wrong_agent_kind",
      agentKind: callerAgent?.kind ?? null,
    });
  }

  const homeBranch = branchesRepo.findByConversationAndBranchKey(
    callerAgent.conversationId,
    "main",
  );
  if (homeBranch == null) {
    throw toolInternalError(
      `Main branch not found for agent conversation ${callerAgent.conversationId}.`,
    );
  }

  const manageableOwnerIds =
    callerAgent.kind === "main"
      ? [callerAgent.id, ...agentsRepo.listByMainAgent(callerAgent.id).map((agent) => agent.id)]
      : [callerAgent.id];

  return {
    callerAgent,
    homeBranchId: homeBranch.id,
    manageableOwnerIds,
  };
}

function requireOwnedJob(
  repo: CronJobsRepo,
  jobId: string | undefined,
  ownerAgentId: string,
): CronJob {
  const job = requireJob(repo, jobId);
  if (job.ownerAgentId !== ownerAgentId) {
    throw toolRecoverableError("You can only change cron jobs owned by this agent.", {
      code: "cron_not_owned_by_caller",
      jobId: job.id,
      ownerAgentId: job.ownerAgentId,
    });
  }
  return job;
}

function requireManageableJob(
  repo: CronJobsRepo,
  jobId: string | undefined,
  manageableOwnerIds: string[],
): CronJob {
  const job = requireJob(repo, jobId);
  if (!manageableOwnerIds.includes(job.ownerAgentId)) {
    throw toolRecoverableError("This cron job is outside the current agent's management scope.", {
      code: "cron_outside_management_scope",
      jobId: job.id,
      ownerAgentId: job.ownerAgentId,
    });
  }
  return job;
}

function requireJob(repo: CronJobsRepo, jobId: string | undefined): CronJob {
  const id = requireField(jobId, "jobId");
  const job = repo.getById(id);
  if (job == null) {
    throw toolRecoverableError(`Unknown cron job ${id}.`, {
      code: "cron_job_not_found",
      jobId: id,
    });
  }
  return job;
}

function requireField(value: string | undefined, field: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw toolRecoverableError(`cron.${field} is required for this action.`, {
      code: "cron_missing_field",
      field,
    });
  }
  return normalized;
}

function requireScheduleKind(value: CronToolArgs["scheduleKind"]): "at" | "every" | "cron" {
  if (value == null) {
    throw toolRecoverableError("cron.scheduleKind is required for this action.", {
      code: "cron_missing_field",
      field: "scheduleKind",
    });
  }
  return value;
}

function buildUpdatePatch(job: CronJob, args: CronToolArgs) {
  const hasScheduleFields =
    args.scheduleKind !== undefined ||
    args.scheduleValue !== undefined ||
    args.timezone !== undefined;
  const hasPrompt = args.prompt !== undefined;
  const hasMeta = args.name !== undefined || args.enabled !== undefined;

  if (!hasScheduleFields && !hasPrompt && !hasMeta) {
    throw toolRecoverableError("cron.update requires at least one field to change.", {
      code: "cron_empty_update",
    });
  }

  const patch: {
    name?: string | null;
    scheduleKind?: "at" | "every" | "cron";
    scheduleValue?: string;
    timezone?: string | null;
    enabled?: boolean;
    payloadJson?: string;
    nextRunAt?: Date | null;
  } = {};

  if (args.name !== undefined) {
    patch.name = args.name;
  }
  if (args.enabled !== undefined) {
    patch.enabled = args.enabled;
  }
  if (args.scheduleKind !== undefined) {
    patch.scheduleKind = args.scheduleKind;
  }
  if (args.scheduleValue !== undefined) {
    patch.scheduleValue = args.scheduleValue.trim();
  }
  if (args.timezone !== undefined) {
    patch.timezone = args.timezone.trim();
  }
  if (args.prompt !== undefined) {
    patch.payloadJson = JSON.stringify({ prompt: args.prompt.trim() });
  }

  if (hasScheduleFields) {
    const scheduleKind = patch.scheduleKind ?? (job.scheduleKind as "at" | "every" | "cron");
    const scheduleValue = patch.scheduleValue ?? job.scheduleValue;
    if ((patch.scheduleKind == null) !== (patch.scheduleValue == null)) {
      throw toolRecoverableError(
        "cron.update must provide both scheduleKind and scheduleValue when changing the schedule.",
        {
          code: "cron_incomplete_schedule_patch",
        },
      );
    }

    patch.nextRunAt = resolveInitialNextRunAt(
      {
        scheduleKind,
        scheduleValue,
        timezone: patch.timezone ?? job.timezone,
      },
      new Date(),
    );
  } else if (args.enabled === false) {
    patch.nextRunAt = null;
  } else if (args.enabled === true && job.nextRunAt == null) {
    patch.nextRunAt = resolveInitialNextRunAt(
      {
        scheduleKind: job.scheduleKind as "at" | "every" | "cron",
        scheduleValue: job.scheduleValue,
        timezone: job.timezone,
      },
      new Date(),
    );
  }

  return patch;
}

function formatCronJobForOutput(job: CronJob) {
  return {
    id: job.id,
    ownerAgentId: job.ownerAgentId,
    targetConversationId: job.targetConversationId,
    targetBranchId: job.targetBranchId,
    name: job.name,
    scheduleKind: job.scheduleKind,
    scheduleValue: job.scheduleValue,
    timezone: job.timezone,
    enabled: job.enabled,
    nextRunAt: job.nextRunAt,
    runningAt: job.runningAt,
    lastRunAt: job.lastRunAt,
    lastStatus: job.lastStatus,
    lastOutput: job.lastOutput,
    prompt: extractPrompt(job.payloadJson),
  };
}

function extractPrompt(payloadJson: string): string | null {
  try {
    const parsed = JSON.parse(payloadJson) as { prompt?: unknown };
    return typeof parsed.prompt === "string" ? parsed.prompt : null;
  } catch {
    return null;
  }
}
