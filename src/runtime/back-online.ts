import { randomUUID } from "node:crypto";
import { Cron } from "croner";

import { createSubsystemLogger } from "@/src/shared/logger.js";
import type { StorageDb } from "@/src/storage/db/client.js";
import { AgentsRepo } from "@/src/storage/repos/agents.repo.js";
import { ChannelInstancesRepo } from "@/src/storage/repos/channel-instances.repo.js";
import { ChannelSurfacesRepo } from "@/src/storage/repos/channel-surfaces.repo.js";
import { ConversationBranchesRepo } from "@/src/storage/repos/conversation-branches.repo.js";
import { ConversationsRepo } from "@/src/storage/repos/conversations.repo.js";
import { CronJobsRepo } from "@/src/storage/repos/cron-jobs.repo.js";
import { MessagesRepo } from "@/src/storage/repos/messages.repo.js";
import { SessionsRepo } from "@/src/storage/repos/sessions.repo.js";
import type { ChannelSurface, CronJob } from "@/src/storage/schema/types.js";

const logger = createSubsystemLogger("runtime/back-online");
const LARK_PROVIDER = "lark";
const LARK_CHANNEL_TYPE = "lark";
const DEFAULT_BACK_ONLINE_THRESHOLD_MS = 30 * 60 * 1000;
const MAX_CARD_JOB_LINES = 6;
const MAX_HIDDEN_MESSAGE_JOB_LINES = 20;
const MAX_CRON_OCCURRENCES_TO_COUNT = 256;

export interface BackOnlineRuntimeClients {
  listInstallations(): Array<{ installationId: string }>;
  getOrCreate(installationId: string): {
    sdk: {
      im: {
        message: {
          create(input: unknown): Promise<unknown>;
          reply(input: unknown): Promise<unknown>;
        };
      };
    };
  };
}

export interface PerformBackOnlineRecoveryInput {
  storage: StorageDb;
  clients: BackOnlineRuntimeClients;
  previousLastSeenAt: Date | null;
  now?: () => Date;
  offlineThresholdMs?: number;
}

export interface BackOnlineRecoveryResult {
  status: "completed" | "skipped";
  reason?:
    | "missing_previous_last_seen"
    | "below_threshold"
    | "no_installations"
    | "no_default_sessions";
  offlineMs?: number;
  notifiedInstallations?: number;
}

export interface PreparedBackOnlineRecovery {
  status: "ready" | "skipped";
  reason?:
    | "missing_previous_last_seen"
    | "below_threshold"
    | "no_installations"
    | "no_default_sessions";
  offlineMs?: number;
  generatedAt: Date;
  notices: PreparedBackOnlineNotice[];
}

interface ResolvedDefaultMainChat {
  installationId: string;
  conversationId: string;
  branchId: string;
  sessionId: string;
  mainAgentId: string;
  surfaces: ChannelSurface[];
}

interface MissedCronJobSummary {
  jobId: string;
  label: string;
  scheduleKind: string;
  firstMissedAt: Date;
  missedRuns: number;
}

interface PreparedBackOnlineNotice {
  mainChat: ResolvedDefaultMainChat;
  userNotice: ReturnType<typeof buildBackOnlineUserNotice>;
  hiddenMessage: string;
}

export function prepareBackOnlineRecovery(
  input: PerformBackOnlineRecoveryInput,
): PreparedBackOnlineRecovery {
  if (input.previousLastSeenAt == null) {
    logger.info("skipping back-online recovery because no previous runtime log timestamp exists");
    return {
      status: "skipped",
      reason: "missing_previous_last_seen",
      generatedAt: input.now?.() ?? new Date(),
      notices: [],
    };
  }

  const now = input.now?.() ?? new Date();
  const previousLastSeenAt = input.previousLastSeenAt;
  const offlineThresholdMs = input.offlineThresholdMs ?? DEFAULT_BACK_ONLINE_THRESHOLD_MS;
  const offlineMs = now.getTime() - previousLastSeenAt.getTime();
  if (offlineMs < offlineThresholdMs) {
    logger.info("skipping back-online recovery because offline duration is below threshold", {
      previousLastSeenAt: input.previousLastSeenAt.toISOString(),
      offlineMs,
      offlineThresholdMs,
    });
    return {
      status: "skipped",
      reason: "below_threshold",
      offlineMs,
      generatedAt: now,
      notices: [],
    };
  }

  const resolvedMainChats = resolveDefaultMainChats({
    storage: input.storage,
    clients: input.clients,
  });
  if (resolvedMainChats.length === 0) {
    logger.info("skipping back-online recovery because no default main chat sessions were found", {
      offlineMs,
      previousLastSeenAt: input.previousLastSeenAt.toISOString(),
    });
    return {
      status: "skipped",
      reason: "no_default_sessions",
      offlineMs,
      generatedAt: now,
      notices: [],
    };
  }

  return {
    status: "ready",
    offlineMs,
    generatedAt: now,
    notices: resolvedMainChats.map((mainChat) => {
      const missedJobs = findMissedCronJobsForMainChat({
        storage: input.storage,
        mainAgentId: mainChat.mainAgentId,
        windowStartExclusive: previousLastSeenAt,
        windowEndInclusive: now,
      });
      return {
        mainChat,
        userNotice: buildBackOnlineUserNotice({
          offlineMs,
          missedJobs,
          generatedAt: now,
        }),
        hiddenMessage: buildBackOnlineHiddenMessage({
          offlineMs,
          missedJobs,
          generatedAt: now,
        }),
      };
    }),
  };
}

export async function performBackOnlineRecovery(
  input: PerformBackOnlineRecoveryInput,
): Promise<BackOnlineRecoveryResult> {
  return dispatchPreparedBackOnlineRecovery({
    storage: input.storage,
    clients: input.clients,
    prepared: prepareBackOnlineRecovery(input),
  });
}

export async function dispatchPreparedBackOnlineRecovery(input: {
  storage: StorageDb;
  clients: BackOnlineRuntimeClients;
  prepared: PreparedBackOnlineRecovery;
}): Promise<BackOnlineRecoveryResult> {
  if (input.prepared.status !== "ready") {
    return {
      status: "skipped",
      ...(input.prepared.reason == null ? {} : { reason: input.prepared.reason }),
      ...(input.prepared.offlineMs == null ? {} : { offlineMs: input.prepared.offlineMs }),
    };
  }

  let notifiedInstallations = 0;
  for (const notice of input.prepared.notices) {
    for (const surface of notice.mainChat.surfaces) {
      try {
        await sendBackOnlineCard({
          clients: input.clients,
          installationId: notice.mainChat.installationId,
          surface,
          notice: notice.userNotice,
        });
      } catch (error) {
        logger.warn("failed to send back-online lark card", {
          installationId: notice.mainChat.installationId,
          conversationId: notice.mainChat.conversationId,
          branchId: notice.mainChat.branchId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    appendBackOnlineHiddenMessage({
      storage: input.storage,
      sessionId: notice.mainChat.sessionId,
      content: notice.hiddenMessage,
      createdAt: input.prepared.generatedAt,
    });
    notifiedInstallations += 1;
  }

  logger.info("completed back-online recovery", {
    offlineMs: input.prepared.offlineMs,
    generatedAt: input.prepared.generatedAt.toISOString(),
    notifiedInstallations,
  });
  return {
    status: "completed",
    ...(input.prepared.offlineMs == null ? {} : { offlineMs: input.prepared.offlineMs }),
    notifiedInstallations,
  };
}

function resolveDefaultMainChats(input: {
  storage: StorageDb;
  clients: BackOnlineRuntimeClients;
}): ResolvedDefaultMainChat[] {
  const channelInstancesRepo = new ChannelInstancesRepo(input.storage);
  const conversationsRepo = new ConversationsRepo(input.storage);
  const branchesRepo = new ConversationBranchesRepo(input.storage);
  const sessionsRepo = new SessionsRepo(input.storage);
  const agentsRepo = new AgentsRepo(input.storage);
  const surfacesRepo = new ChannelSurfacesRepo(input.storage);
  const resolved: ResolvedDefaultMainChat[] = [];

  for (const installation of input.clients.listInstallations()) {
    const channelInstance = channelInstancesRepo.getByProviderAndAccountKey(
      LARK_PROVIDER,
      installation.installationId,
    );
    if (channelInstance == null) {
      continue;
    }

    const conversation =
      conversationsRepo.listByChannelInstanceId(channelInstance.id, 1)[0] ?? null;
    if (conversation == null) {
      continue;
    }

    const mainBranch = branchesRepo.findByConversationAndBranchKey(conversation.id, "main");
    if (mainBranch == null) {
      continue;
    }

    const session = sessionsRepo.findLatestByConversationBranch(conversation.id, mainBranch.id, {
      purpose: "chat",
      statuses: ["active", "paused"],
    });
    if (session == null) {
      continue;
    }

    const mainAgent = agentsRepo.findByConversationId(conversation.id);
    if (mainAgent == null || mainAgent.kind !== "main") {
      continue;
    }

    const surfaces = surfacesRepo.listByConversationBranch({
      channelType: LARK_CHANNEL_TYPE,
      conversationId: conversation.id,
      branchId: mainBranch.id,
    });
    resolved.push({
      installationId: installation.installationId,
      conversationId: conversation.id,
      branchId: mainBranch.id,
      sessionId: session.id,
      mainAgentId: mainAgent.id,
      surfaces,
    });
  }

  return resolved;
}

function findMissedCronJobsForMainChat(input: {
  storage: StorageDb;
  mainAgentId: string;
  windowStartExclusive: Date;
  windowEndInclusive: Date;
}): MissedCronJobSummary[] {
  const agentsRepo = new AgentsRepo(input.storage);
  const cronJobsRepo = new CronJobsRepo(input.storage);
  const ownerAgentIds = [
    input.mainAgentId,
    ...agentsRepo.listByMainAgent(input.mainAgentId).map((agent) => agent.id),
  ];
  const ownerAgentById = new Map(
    ownerAgentIds.map((agentId) => [agentId, agentsRepo.getById(agentId)]),
  );

  return cronJobsRepo
    .list({
      ownerAgentIds,
      includeDisabled: false,
      limit: 1000,
    })
    .map((job) =>
      summarizeMissedCronJob({
        job,
        ownerLabel: buildOwnerLabel(ownerAgentById.get(job.ownerAgentId) ?? null),
        windowStartExclusive: input.windowStartExclusive,
        windowEndInclusive: input.windowEndInclusive,
      }),
    )
    .filter((summary): summary is MissedCronJobSummary => summary != null)
    .sort((left, right) => left.firstMissedAt.getTime() - right.firstMissedAt.getTime());
}

function summarizeMissedCronJob(input: {
  job: CronJob;
  ownerLabel: string | null;
  windowStartExclusive: Date;
  windowEndInclusive: Date;
}): MissedCronJobSummary | null {
  const firstMissedAt = resolveFirstMissedAt(
    input.job,
    input.windowStartExclusive,
    input.windowEndInclusive,
  );
  if (firstMissedAt == null) {
    return null;
  }

  return {
    jobId: input.job.id,
    label:
      input.ownerLabel == null
        ? input.job.name?.trim() || input.job.id
        : `${input.ownerLabel}: ${input.job.name?.trim() || input.job.id}`,
    scheduleKind: input.job.scheduleKind,
    firstMissedAt,
    missedRuns: countMissedRuns(input.job, firstMissedAt, input.windowEndInclusive),
  };
}

function resolveFirstMissedAt(
  job: CronJob,
  windowStartExclusive: Date,
  windowEndInclusive: Date,
): Date | null {
  switch (job.scheduleKind) {
    case "at":
      return resolveAtFirstMissedAt(job.scheduleValue, windowStartExclusive, windowEndInclusive);
    case "every":
      return resolveEveryFirstMissedAt(job, windowStartExclusive, windowEndInclusive);
    case "cron":
      return resolveCronFirstMissedAt(job, windowStartExclusive, windowEndInclusive);
    default:
      return null;
  }
}

function resolveAtFirstMissedAt(
  scheduleValue: string,
  windowStartExclusive: Date,
  windowEndInclusive: Date,
): Date | null {
  const scheduledAt = new Date(scheduleValue);
  if (Number.isNaN(scheduledAt.getTime())) {
    return null;
  }
  if (scheduledAt.getTime() <= windowStartExclusive.getTime()) {
    return null;
  }
  return scheduledAt.getTime() <= windowEndInclusive.getTime() ? scheduledAt : null;
}

function resolveEveryFirstMissedAt(
  job: CronJob,
  windowStartExclusive: Date,
  windowEndInclusive: Date,
): Date | null {
  if (job.nextRunAt == null) {
    return null;
  }

  const intervalMs = Number.parseInt(job.scheduleValue, 10);
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    return null;
  }

  const nextRunAt = new Date(job.nextRunAt);
  if (Number.isNaN(nextRunAt.getTime())) {
    return null;
  }

  if (nextRunAt.getTime() > windowEndInclusive.getTime()) {
    return null;
  }
  if (nextRunAt.getTime() > windowStartExclusive.getTime()) {
    return nextRunAt;
  }

  const offsetFromWindowStart = windowStartExclusive.getTime() - nextRunAt.getTime();
  const intervalsToAdvance = Math.floor(offsetFromWindowStart / intervalMs) + 1;
  const candidate = new Date(nextRunAt.getTime() + intervalsToAdvance * intervalMs);
  return candidate.getTime() <= windowEndInclusive.getTime() ? candidate : null;
}

function resolveCronFirstMissedAt(
  job: CronJob,
  windowStartExclusive: Date,
  windowEndInclusive: Date,
): Date | null {
  try {
    const cron = new Cron(
      job.scheduleValue,
      job.timezone == null
        ? undefined
        : {
            timezone: job.timezone,
          },
    );

    if (job.nextRunAt != null) {
      const nextRunAt = new Date(job.nextRunAt);
      if (
        !Number.isNaN(nextRunAt.getTime()) &&
        nextRunAt.getTime() > windowStartExclusive.getTime() &&
        nextRunAt.getTime() <= windowEndInclusive.getTime()
      ) {
        return nextRunAt;
      }
    }

    const candidate = cron.nextRun(windowStartExclusive);
    if (candidate == null) {
      return null;
    }
    return candidate.getTime() <= windowEndInclusive.getTime() ? candidate : null;
  } catch {
    return null;
  }
}

function countMissedRuns(job: CronJob, firstMissedAt: Date, windowEndInclusive: Date): number {
  switch (job.scheduleKind) {
    case "at":
      return 1;
    case "every": {
      const intervalMs = Number.parseInt(job.scheduleValue, 10);
      if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
        return 1;
      }
      return 1 + Math.floor((windowEndInclusive.getTime() - firstMissedAt.getTime()) / intervalMs);
    }
    case "cron":
      return countMissedCronRuns(job, firstMissedAt, windowEndInclusive);
    default:
      return 1;
  }
}

function countMissedCronRuns(job: CronJob, firstMissedAt: Date, windowEndInclusive: Date): number {
  try {
    const cron = new Cron(
      job.scheduleValue,
      job.timezone == null
        ? undefined
        : {
            timezone: job.timezone,
          },
    );
    let count = 1;
    let cursor = firstMissedAt;
    while (count < MAX_CRON_OCCURRENCES_TO_COUNT) {
      const next = cron.nextRun(cursor);
      if (next == null || next.getTime() > windowEndInclusive.getTime()) {
        return count;
      }
      count += 1;
      cursor = next;
    }
    return count;
  } catch {
    return 1;
  }
}

function buildOwnerLabel(
  agent: {
    kind: string;
    displayName: string | null;
    id: string;
  } | null,
): string | null {
  if (agent == null || agent.kind !== "sub") {
    return null;
  }
  return agent.displayName?.trim() || agent.id;
}

function buildBackOnlineUserNotice(input: {
  offlineMs: number;
  missedJobs: MissedCronJobSummary[];
  generatedAt: Date;
}) {
  const offlineText = formatDuration(input.offlineMs);
  const jobLines = input.missedJobs
    .slice(0, MAX_CARD_JOB_LINES)
    .map((job) => `- ${job.label} at ${formatShortTimestamp(job.firstMissedAt)}`);
  if (input.missedJobs.length > MAX_CARD_JOB_LINES) {
    jobLines.push(`- and ${input.missedJobs.length - MAX_CARD_JOB_LINES} more`);
  }

  return {
    title: "🟢 Back online",
    summary:
      input.missedJobs.length === 0
        ? `⏰ Offline for ${offlineText}. No scheduled tasks were missed.`
        : `⏰ Offline for ${offlineText}. Missed ${input.missedJobs.length} scheduled task${input.missedJobs.length === 1 ? "" : "s"}.`,
    markdownSections:
      input.missedJobs.length === 0
        ? [`Offline for **${offlineText}**.`]
        : [`Offline for **${offlineText}**.`, ["Missed scheduled tasks:", ...jobLines].join("\n")],
    hiddenContent:
      input.missedJobs.length === 0
        ? `Back online after ${offlineText}. No scheduled tasks were missed.`
        : [
            `Back online after ${offlineText}.`,
            `Missed ${input.missedJobs.length} scheduled task${input.missedJobs.length === 1 ? "" : "s"} while offline:`,
            ...input.missedJobs
              .slice(0, MAX_HIDDEN_MESSAGE_JOB_LINES)
              .map(
                (job) =>
                  `- ${job.label} at ${formatShortTimestamp(job.firstMissedAt)}${job.missedRuns > 1 ? ` (${job.missedRuns} runs)` : ""}`,
              ),
            ...(input.missedJobs.length > MAX_HIDDEN_MESSAGE_JOB_LINES
              ? [`- and ${input.missedJobs.length - MAX_HIDDEN_MESSAGE_JOB_LINES} more`]
              : []),
            `Generated at ${formatShortTimestamp(input.generatedAt)}.`,
          ].join("\n"),
  };
}

function buildBackOnlineHiddenMessage(input: {
  offlineMs: number;
  missedJobs: MissedCronJobSummary[];
  generatedAt: Date;
}): string {
  const notice = buildBackOnlineUserNotice(input);
  return [
    '<system_event type="back_online">',
    notice.hiddenContent,
    "Do not assume any missed task was rerun automatically.",
    "If the user asks, explain what was missed and rerun only on explicit request.",
    "</system_event>",
  ].join("\n");
}

async function sendBackOnlineCard(input: {
  clients: BackOnlineRuntimeClients;
  installationId: string;
  surface: ChannelSurface;
  notice: ReturnType<typeof buildBackOnlineUserNotice>;
}): Promise<void> {
  const surfaceObject = parseSurfaceObject(input.surface.surfaceObjectJson);
  const chatId = readStringValue(surfaceObject.chat_id);
  if (chatId == null) {
    return;
  }

  const client = input.clients.getOrCreate(input.installationId);
  const card = {
    schema: "2.0",
    config: {
      update_multi: true,
      wide_screen_mode: false,
      summary: {
        content: input.notice.summary,
      },
    },
    header: {
      title: {
        tag: "plain_text",
        content: input.notice.title,
      },
      template: "turquoise",
    },
    body: {
      elements: input.notice.markdownSections.flatMap((section, index) => [
        ...(index === 0 ? [] : [{ tag: "hr" as const }]),
        {
          tag: "markdown",
          content: section,
        },
      ]),
    },
  };

  const replyToMessageId = readStringValue(surfaceObject.reply_to_message_id);
  if (replyToMessageId != null) {
    await client.sdk.im.message.reply({
      path: { message_id: replyToMessageId },
      data: {
        msg_type: "interactive",
        content: JSON.stringify(card),
        reply_in_thread: true,
      },
    });
    return;
  }

  await client.sdk.im.message.create({
    params: { receive_id_type: "chat_id" },
    data: {
      receive_id: chatId,
      msg_type: "interactive",
      content: JSON.stringify(card),
    },
  });
}

function appendBackOnlineHiddenMessage(input: {
  storage: StorageDb;
  sessionId: string;
  content: string;
  createdAt: Date;
}) {
  const messagesRepo = new MessagesRepo(input.storage);
  messagesRepo.append({
    id: randomUUID(),
    sessionId: input.sessionId,
    seq: messagesRepo.getNextSeq(input.sessionId),
    role: "user",
    messageType: "back_online",
    visibility: "hidden_system",
    payloadJson: JSON.stringify({
      content: input.content,
    }),
    createdAt: input.createdAt,
  });
}

function parseSurfaceObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed != null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {}

  return {};
}

function readStringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function formatDuration(durationMs: number): string {
  const totalMinutes = Math.max(1, Math.floor(durationMs / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) {
    return `${minutes}m`;
  }
  if (minutes <= 0) {
    return `${hours}h`;
  }
  return `${hours}h ${minutes}m`;
}

function formatShortTimestamp(value: Date): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(value);
  const lookup = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${lookup("year")}-${lookup("month")}-${lookup("day")} ${lookup("hour")}:${lookup("minute")}`;
}
