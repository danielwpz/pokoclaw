/**
 * Runtime status aggregation and presentation helpers.
 *
 * Builds conversation-level snapshots (model, usage, active runs, approvals)
 * from storage + live runtime state. Channel adapters can render the snapshot
 * as plain text or rich cards without duplicating status logic.
 */
import { readFileSync } from "node:fs";
import type { ResolvedModel } from "@/src/agent/llm/models.js";
import type { ProviderRegistry } from "@/src/agent/llm/provider-registry.js";
import type { RuntimeControlService } from "@/src/runtime/control.js";
import { resolveSessionLiveState } from "@/src/runtime/live-state.js";
import type { StorageDb } from "@/src/storage/db/client.js";
import { AgentsRepo } from "@/src/storage/repos/agents.repo.js";
import { ApprovalsRepo } from "@/src/storage/repos/approvals.repo.js";
import type { MessageUsage } from "@/src/storage/repos/messages.repo.js";
import { MessagesRepo } from "@/src/storage/repos/messages.repo.js";
import { SessionsRepo } from "@/src/storage/repos/sessions.repo.js";
import type { Message, Session } from "@/src/storage/schema/types.js";

export interface ConversationStatusInput {
  conversationId: string;
  sessionId: string;
  scenario: "chat" | "cron" | "subagent";
}

export interface StatusModelSnapshot {
  configuredModelId: string | null;
  providerId: string | null;
  upstreamModelId: string | null;
  modelApi: string | null;
  supportsReasoning: boolean | null;
  source: "latest_assistant" | "agent_default" | "scenario_default" | "unknown";
}

export interface StatusUsageSnapshot extends MessageUsage {}

export interface StatusActiveRunSnapshot {
  runId: string;
  sessionId: string;
  branchId: string;
  scenario: string;
  sessionPurpose: string | null;
  taskRunId: string | null;
  taskRunType: string | null;
  taskRunStatus: string | null;
}

export interface StatusPendingApprovalSnapshot {
  approvalId: number;
  approvalTarget: "user" | "main_agent";
  reasonText: string | null;
  createdAt: string;
  expiresAt: string | null;
}

export interface ConversationStatusSnapshot {
  conversationId: string;
  sessionId: string;
  model: StatusModelSnapshot;
  sessionUsage: StatusUsageSnapshot | null;
  latestTurnUsage: StatusUsageSnapshot | null;
  activeRuns: StatusActiveRunSnapshot[];
  pendingApprovals: StatusPendingApprovalSnapshot[];
}

export interface StatusPresentationSnapshot {
  title: string;
  summary: string;
  markdownSections: string[];
}

export class RuntimeStatusService {
  constructor(
    private readonly deps: {
      storage: StorageDb;
      control: RuntimeControlService;
      models: ProviderRegistry;
    },
  ) {}

  getConversationStatus(input: ConversationStatusInput): ConversationStatusSnapshot {
    const sessionsRepo = new SessionsRepo(this.deps.storage);
    const approvalsRepo = new ApprovalsRepo(this.deps.storage);
    const messagesRepo = new MessagesRepo(this.deps.storage);
    const agentsRepo = new AgentsRepo(this.deps.storage);

    const session = sessionsRepo.getById(input.sessionId);
    if (session == null) {
      throw new Error(`Session not found for /status: ${input.sessionId}`);
    }

    const latestAssistant = messagesRepo.getLatestAssistantBySession(session.id);
    const model = resolveStatusModel({
      latestAssistant,
      session,
      agentsRepo,
      models: this.deps.models,
      scenario: input.scenario,
    });

    const sessionUsage = aggregateSessionUsage({
      session,
      messagesRepo,
    });

    const sessions = sessionsRepo.listByConversation(input.conversationId, {
      limit: 200,
    });
    const pendingApprovals = sessions.flatMap((candidate) =>
      approvalsRepo
        .listBySession(candidate.id, {
          statuses: ["pending"],
          limit: 50,
        })
        .map((approval) => ({
          approvalId: approval.id,
          approvalTarget: approval.approvalTarget as "user" | "main_agent",
          reasonText: approval.reasonText,
          createdAt: approval.createdAt,
          expiresAt: approval.expiresAt,
        })),
    );

    const activeRuns = this.deps.control
      .listActiveRunsByConversation(input.conversationId)
      .map((run) => {
        const live = resolveSessionLiveState({
          db: this.deps.storage,
          sessionId: run.sessionId,
        });

        return {
          runId: run.runId,
          sessionId: run.sessionId,
          branchId: run.branchId,
          scenario: run.scenario,
          sessionPurpose: live?.session.purpose ?? null,
          taskRunId: live?.taskRun?.id ?? null,
          taskRunType: live?.taskRun?.runType ?? null,
          taskRunStatus: live?.taskRun?.status ?? null,
        };
      });

    return {
      conversationId: input.conversationId,
      sessionId: input.sessionId,
      model,
      sessionUsage,
      latestTurnUsage: latestAssistant == null ? null : parseMessageUsage(latestAssistant),
      activeRuns,
      pendingApprovals,
    };
  }
}

export function formatConversationStatusText(snapshot: ConversationStatusSnapshot): string {
  const lines: string[] = [];

  lines.push("当前状态");
  lines.push("");

  const modelLineParts = [
    snapshot.model.configuredModelId,
    snapshot.model.upstreamModelId,
    snapshot.model.providerId,
    snapshot.model.modelApi,
  ].filter((value): value is string => value != null && value.length > 0);
  lines.push(`模型: ${modelLineParts.length > 0 ? modelLineParts.join(" / ") : "未知"}`);
  if (snapshot.model.supportsReasoning != null) {
    lines.push(`Reasoning: ${snapshot.model.supportsReasoning ? "支持" : "不支持"}`);
  }

  lines.push("");
  lines.push("Usage");
  if (snapshot.sessionUsage == null) {
    lines.push("- 当前 session 还没有可用 usage。");
  } else {
    lines.push(`- 当前 session 累计: ${formatUsageLine(snapshot.sessionUsage)}`);
  }
  if (snapshot.latestTurnUsage == null) {
    lines.push("- 最近一次回复: 暂无。");
  } else {
    lines.push(`- 最近一次回复: ${formatUsageLine(snapshot.latestTurnUsage)}`);
  }

  lines.push("");
  lines.push("运行中");
  if (snapshot.activeRuns.length === 0) {
    lines.push("- 当前 conversation 没有活跃 run。");
  } else {
    for (const run of snapshot.activeRuns) {
      const kind =
        run.taskRunType == null
          ? `${run.sessionPurpose ?? "unknown"} / ${run.scenario}`
          : `${run.sessionPurpose ?? "task"} / ${run.taskRunType}`;
      const status = run.taskRunStatus == null ? "" : ` / ${run.taskRunStatus}`;
      lines.push(`- ${run.runId}: ${kind}${status}`);
    }
  }

  lines.push("");
  lines.push("待处理授权");
  if (snapshot.pendingApprovals.length === 0) {
    lines.push("- 当前没有 pending approval。");
  } else {
    for (const approval of snapshot.pendingApprovals.slice(0, 5)) {
      lines.push(
        `- #${approval.approvalId} (${approval.approvalTarget}) ${approval.reasonText ?? "无说明"}`,
      );
    }
    if (snapshot.pendingApprovals.length > 5) {
      lines.push(`- 其余 ${snapshot.pendingApprovals.length - 5} 条未展开`);
    }
  }

  return lines.join("\n");
}

export function buildConversationStatusPresentation(
  snapshot: ConversationStatusSnapshot,
): StatusPresentationSnapshot {
  return {
    title: "当前状态",
    summary: snapshot.activeRuns.length > 0 ? "存在活跃 run" : "当前空闲",
    markdownSections: [
      [
        `**版本**: \`${getPokeclawVersion()}\``,
        `**会话**: \`${snapshot.sessionId}\``,
        `**模型**: ${formatModelLine(snapshot.model)}`,
        ...(snapshot.model.supportsReasoning == null
          ? []
          : [`**Reasoning**: ${snapshot.model.supportsReasoning ? "支持" : "不支持"}`]),
      ].join("\n"),
      [
        "### Usage",
        snapshot.sessionUsage == null
          ? "- 当前 session 还没有可用 usage。"
          : `- 当前 session 累计: ${formatUsageLine(snapshot.sessionUsage)}`,
        snapshot.latestTurnUsage == null
          ? "- 最近一次回复: 暂无。"
          : `- 最近一次回复: ${formatUsageLine(snapshot.latestTurnUsage)}`,
      ].join("\n"),
      [
        "### 运行中",
        snapshot.activeRuns.length === 0
          ? "- 当前 conversation 没有活跃 run。"
          : snapshot.activeRuns
              .map((run) => {
                const kind =
                  run.taskRunType == null
                    ? `${run.sessionPurpose ?? "unknown"} / ${run.scenario}`
                    : `${run.sessionPurpose ?? "task"} / ${run.taskRunType}`;
                const status = run.taskRunStatus == null ? "" : ` / ${run.taskRunStatus}`;
                return `- \`${run.runId}\`: ${kind}${status}`;
              })
              .join("\n"),
      ].join("\n"),
      [
        "### 待处理授权",
        snapshot.pendingApprovals.length === 0
          ? "- 当前没有 pending approval。"
          : snapshot.pendingApprovals
              .slice(0, 5)
              .map(
                (approval) =>
                  `- \`#${approval.approvalId}\` (${approval.approvalTarget}) ${approval.reasonText ?? "无说明"}`,
              )
              .concat(
                snapshot.pendingApprovals.length > 5
                  ? [`- 其余 ${snapshot.pendingApprovals.length - 5} 条未展开`]
                  : [],
              )
              .join("\n"),
      ].join("\n"),
    ],
  };
}

function resolveStatusModel(input: {
  latestAssistant: Message | null;
  session: Session;
  agentsRepo: AgentsRepo;
  models: ProviderRegistry;
  scenario: "chat" | "cron" | "subagent";
}): StatusModelSnapshot {
  const latestAssistantModel = resolveCatalogModelFromStoredAssistant({
    latestAssistant: input.latestAssistant,
    models: input.models,
  });
  if (input.latestAssistant != null) {
    return {
      configuredModelId: latestAssistantModel?.id ?? null,
      providerId: input.latestAssistant.provider ?? null,
      upstreamModelId: input.latestAssistant.model ?? null,
      modelApi: input.latestAssistant.modelApi ?? null,
      supportsReasoning: latestAssistantModel?.supportsReasoning ?? null,
      source: "latest_assistant",
    };
  }

  const ownerAgent =
    input.session.ownerAgentId == null
      ? null
      : input.agentsRepo.getById(input.session.ownerAgentId);
  if (ownerAgent?.defaultModel != null) {
    const model = input.models.getModel(ownerAgent.defaultModel);
    if (model != null) {
      return modelToStatusSnapshot(model, "agent_default");
    }
  }

  const scenarioModel = input.models.getScenarioModel(input.scenario);
  if (scenarioModel != null) {
    return modelToStatusSnapshot(scenarioModel, "scenario_default");
  }

  return {
    configuredModelId: null,
    providerId: null,
    upstreamModelId: null,
    modelApi: null,
    supportsReasoning: null,
    source: "unknown",
  };
}

function resolveCatalogModelFromStoredAssistant(input: {
  latestAssistant: Message | null;
  models: ProviderRegistry;
}): ResolvedModel | null {
  if (input.latestAssistant?.provider == null || input.latestAssistant.model == null) {
    return null;
  }

  return (
    input.models
      .listModels()
      .find(
        (model) =>
          model.provider.id === input.latestAssistant?.provider &&
          model.upstreamId === input.latestAssistant?.model,
      ) ?? null
  );
}

function modelToStatusSnapshot(
  model: ResolvedModel,
  source: StatusModelSnapshot["source"],
): StatusModelSnapshot {
  return {
    configuredModelId: model.id,
    providerId: model.provider.id,
    upstreamModelId: model.upstreamId,
    modelApi: model.provider.api,
    supportsReasoning: model.supportsReasoning,
    source,
  };
}

function aggregateSessionUsage(input: {
  session: Session;
  messagesRepo: MessagesRepo;
}): StatusUsageSnapshot | null {
  const total = emptyUsage();
  let sawAny = false;

  const compactSummaryUsage = parseUsageJson(input.session.compactSummaryUsageJson);
  if (compactSummaryUsage != null) {
    addUsage(total, compactSummaryUsage);
    sawAny = true;
  }

  const suffixMessages = input.messagesRepo.listBySession(input.session.id, {
    afterSeq: input.session.compactCursor,
  });
  for (const message of suffixMessages) {
    if (message.role !== "assistant") {
      continue;
    }
    const usage = parseMessageUsage(message);
    if (usage == null) {
      continue;
    }
    addUsage(total, usage);
    sawAny = true;
  }

  return sawAny ? total : null;
}

function parseMessageUsage(message: Message): StatusUsageSnapshot | null {
  return parseUsageJson(message.usageJson);
}

function parseUsageJson(usageJson: string | null | undefined): StatusUsageSnapshot | null {
  if (usageJson == null) {
    return null;
  }

  try {
    const parsed = JSON.parse(usageJson) as Partial<MessageUsage>;
    if (
      typeof parsed.input !== "number" ||
      typeof parsed.output !== "number" ||
      typeof parsed.cacheRead !== "number" ||
      typeof parsed.cacheWrite !== "number" ||
      typeof parsed.totalTokens !== "number"
    ) {
      return null;
    }

    return {
      input: Math.floor(parsed.input),
      output: Math.floor(parsed.output),
      cacheRead: Math.floor(parsed.cacheRead),
      cacheWrite: Math.floor(parsed.cacheWrite),
      totalTokens: Math.floor(parsed.totalTokens),
      cost: {
        input: parsed.cost?.input ?? 0,
        output: parsed.cost?.output ?? 0,
        cacheRead: parsed.cost?.cacheRead ?? 0,
        cacheWrite: parsed.cost?.cacheWrite ?? 0,
        total: parsed.cost?.total ?? 0,
      },
    };
  } catch {
    return null;
  }
}

function emptyUsage(): StatusUsageSnapshot {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

function addUsage(target: StatusUsageSnapshot, usage: StatusUsageSnapshot): void {
  target.input += usage.input;
  target.output += usage.output;
  target.cacheRead += usage.cacheRead;
  target.cacheWrite += usage.cacheWrite;
  target.totalTokens += usage.totalTokens;
  if (target.cost != null) {
    target.cost.input += usage.cost?.input ?? 0;
    target.cost.output += usage.cost?.output ?? 0;
    target.cost.cacheRead += usage.cost?.cacheRead ?? 0;
    target.cost.cacheWrite += usage.cost?.cacheWrite ?? 0;
    target.cost.total += usage.cost?.total ?? 0;
  }
}

function formatUsageLine(usage: StatusUsageSnapshot): string {
  const tokens = [
    `总 ${formatCount(usage.totalTokens)}`,
    `输入 ${formatCount(usage.input)}`,
    `输出 ${formatCount(usage.output)}`,
  ];

  if (usage.cacheRead > 0 || usage.cacheWrite > 0) {
    tokens.push(`缓存读 ${formatCount(usage.cacheRead)}`);
    tokens.push(`缓存写 ${formatCount(usage.cacheWrite)}`);
  }

  const cost = usage.cost?.total ?? 0;
  if (cost > 0) {
    tokens.push(`Cost $${cost.toFixed(6)}`);
  }

  return tokens.join(" / ");
}

function formatModelLine(model: StatusModelSnapshot): string {
  const parts = [
    model.configuredModelId,
    model.upstreamModelId,
    model.providerId,
    model.modelApi,
  ].filter((value): value is string => value != null && value.length > 0);
  return parts.length > 0 ? parts.join(" / ") : "未知";
}

function getPokeclawVersion(): string {
  try {
    const raw = readFileSync(new URL("../../package.json", import.meta.url), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.length > 0
      ? parsed.version
      : "unknown";
  } catch {
    return "unknown";
  }
}

function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}
