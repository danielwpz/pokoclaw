/**
 * Subagent provisioning and request lifecycle.
 *
 * Implements create/approve/deny flows for subagent creation requests,
 * including conversation/session provisioning and initial security boundaries.
 */
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import { buildSystemPolicy } from "@/src/security/policy.js";
import {
  appendFsSubtreeSuffix,
  type PermissionScope,
  serializePermissionScope,
} from "@/src/security/scope.js";
import { SecurityService } from "@/src/security/service.js";
import { createSubsystemLogger } from "@/src/shared/logger.js";
import {
  buildSubagentWorkspaceDir,
  POKOCLAW_SYSTEM_DIR,
  POKOCLAW_WORKSPACE_DIR,
} from "@/src/shared/paths.js";
import { resolveRepoLocalSkillDirs } from "@/src/shared/repo-skill-roots.js";
import type { StorageDb } from "@/src/storage/db/client.js";
import { AgentsRepo } from "@/src/storage/repos/agents.repo.js";
import { ChannelSurfacesRepo } from "@/src/storage/repos/channel-surfaces.repo.js";
import { ConversationBranchesRepo } from "@/src/storage/repos/conversation-branches.repo.js";
import { ConversationsRepo } from "@/src/storage/repos/conversations.repo.js";
import { SessionsRepo } from "@/src/storage/repos/sessions.repo.js";
import { SubagentCreationRequestsRepo } from "@/src/storage/repos/subagent-creation-requests.repo.js";
import type {
  Agent,
  Conversation,
  ConversationBranch,
  Session,
  SubagentCreationRequest,
} from "@/src/storage/schema/types.js";

const logger = createSubsystemLogger("orchestration/subagents");

export const SUBAGENT_CREATION_REQUEST_TTL_MS = 30 * 60 * 1000;

export interface CreateSubagentInput {
  sourceSessionId: string;
  title: string;
  description: string;
  initialTask: string;
  cwd?: string;
  initialExtraScopes?: PermissionScope[];
  createdAt?: Date;
  expiresAt?: Date;
}

export interface SubmittedSubagentCreationRequest {
  request: SubagentCreationRequest;
  workdir: string;
  privateWorkspaceDir: string;
  initialExtraScopes: PermissionScope[];
}

export interface ApproveSubagentCreationRequestInput {
  requestId: string;
  decidedAt?: Date;
}

export interface DenySubagentCreationRequestInput {
  requestId: string;
  decidedAt?: Date;
  reasonText?: string | null;
}

export interface ProvisionSubagentSurfaceInput {
  conversationId: string;
  sourceConversationId: string;
  channelInstanceId: string;
  title: string;
  description: string;
  initialTask: string;
  workdir: string;
  privateWorkspaceDir: string;
  preferredSurface: "independent_chat";
}

export interface ProvisionedSubagentChannelSurface {
  channelType: string;
  channelInstallationId: string;
  surfaceKey: string;
  surfaceObjectJson: string;
}

export interface CleanupProvisionedSubagentSurfaceInput {
  channelInstanceId: string;
  externalChatId: string;
}

export type ProvisionSubagentSurfaceResult =
  | {
      status: "provisioned";
      externalChatId: string;
      shareLink: string | null;
      conversationKind: "dm" | "group";
      channelSurface: ProvisionedSubagentChannelSurface;
    }
  | {
      status: "failed";
      reason: string;
      retryable: boolean;
    };

export interface SubagentPrivateWorkspaceManager {
  ensureDirectory(path: string): Promise<void>;
}

export interface SubagentConversationSurfaceProvisioner {
  provisionSubagentSurface(
    input: ProvisionSubagentSurfaceInput,
  ): Promise<ProvisionSubagentSurfaceResult>;
  cleanupProvisionedSubagentSurface?(input: CleanupProvisionedSubagentSurfaceInput): Promise<void>;
}

export interface SubagentManagerIngress {
  submitMessage(input: {
    sessionId: string;
    scenario: "chat";
    content: string;
    messageType: string;
    visibility: string;
    createdAt?: Date;
  }): Promise<unknown>;
}

export interface CreatedSubagent {
  conversation: Conversation;
  branch: ConversationBranch;
  agent: Agent;
  session: Session;
  externalChatId: string;
  shareLink: string | null;
  workdir: string;
  privateWorkspaceDir: string;
}

export interface SubagentManagerDependencies {
  storage: StorageDb;
  ingress: SubagentManagerIngress;
  provisioner?: SubagentConversationSurfaceProvisioner;
  privateWorkspace?: SubagentPrivateWorkspaceManager;
}

export class SubagentManager {
  constructor(private readonly deps: SubagentManagerDependencies) {}

  submitCreateRequest(input: CreateSubagentInput): SubmittedSubagentCreationRequest {
    const createdAt = input.createdAt ?? new Date();
    const expiresAt =
      input.expiresAt ?? new Date(createdAt.getTime() + SUBAGENT_CREATION_REQUEST_TTL_MS);
    const source = this.resolveValidatedMainChatSource(input.sourceSessionId);
    const normalizedTitle = normalizeRequiredTrimmed("title", input.title);
    const normalizedDescription = normalizeRequiredTrimmed("description", input.description);
    const normalizedInitialTask = normalizeRequiredTrimmed("initialTask", input.initialTask);
    const initialExtraScopes = dedupeScopes(input.initialExtraScopes ?? []);
    const requestId = randomUUID();
    const privateWorkspaceDir = buildSubagentWorkspaceDir(requestId);
    const workdir = normalizeSubagentWorkdir(input.cwd, privateWorkspaceDir);

    const repo = new SubagentCreationRequestsRepo(this.deps.storage);
    repo.create({
      id: requestId,
      sourceSessionId: source.session.id,
      sourceAgentId: source.mainAgent.id,
      sourceConversationId: source.conversation.id,
      channelInstanceId: source.conversation.channelInstanceId,
      title: normalizedTitle,
      description: normalizedDescription,
      initialTask: normalizedInitialTask,
      workdir,
      initialExtraScopesJson: serializePermissionScopes(initialExtraScopes),
      status: "pending",
      createdAt,
      updatedAt: createdAt,
      expiresAt,
    });

    const request = repo.getById(requestId);
    if (request == null) {
      throw new Error(`Failed to persist SubAgent creation request ${requestId}`);
    }

    logger.info("submitted subagent creation request", {
      requestId,
      sourceSessionId: source.session.id,
      mainAgentId: source.mainAgent.id,
      title: normalizedTitle,
      workdir,
      expiresAt: request.expiresAt,
    });

    return {
      request,
      workdir,
      privateWorkspaceDir,
      initialExtraScopes,
    };
  }

  async approveCreateRequest(input: ApproveSubagentCreationRequestInput): Promise<CreatedSubagent> {
    const decidedAt = input.decidedAt ?? new Date();
    const request = this.getPendingRequestOrThrow(input.requestId, decidedAt);
    const provisioner = this.requireProvisioner();
    const requestsRepo = new SubagentCreationRequestsRepo(this.deps.storage);

    const conversationId = randomUUID();
    const branchId = randomUUID();
    const agentId = request.id;
    const sessionId = randomUUID();
    const privateWorkspaceDir = buildSubagentWorkspaceDir(agentId);

    try {
      await this.ensurePrivateWorkspaceDir(privateWorkspaceDir);
    } catch (error: unknown) {
      const failureReason = error instanceof Error ? error.message : String(error);
      this.markRequestFailed({
        requestId: request.id,
        failureReason: `Failed to initialize the SubAgent private workspace ${privateWorkspaceDir}: ${failureReason}`,
        decidedAt,
      });
      throw new Error(`Failed to initialize the SubAgent private workspace: ${failureReason}`);
    }

    requestsRepo.updateStatus({
      id: request.id,
      status: "provisioning",
      failureReason: null,
      updatedAt: decidedAt,
    });

    let provisioned: ProvisionSubagentSurfaceResult;
    try {
      provisioned = await provisioner.provisionSubagentSurface({
        conversationId,
        sourceConversationId: request.sourceConversationId,
        channelInstanceId: request.channelInstanceId,
        title: request.title,
        description: request.description,
        initialTask: request.initialTask,
        workdir: request.workdir,
        privateWorkspaceDir,
        preferredSurface: "independent_chat",
      });
    } catch (error: unknown) {
      const failureReason = error instanceof Error ? error.message : String(error);
      this.markRequestFailed({
        requestId: request.id,
        failureReason,
        decidedAt,
      });
      throw new Error(`Failed to provision the SubAgent conversation surface: ${failureReason}`);
    }

    if (provisioned.status !== "provisioned") {
      this.markRequestFailed({
        requestId: request.id,
        failureReason: provisioned.reason,
        decidedAt,
      });
      throw new Error(
        `Failed to provision the SubAgent conversation surface: ${provisioned.reason}`,
      );
    }

    const initialExtraScopes = parseSerializedPermissionScopes(request.initialExtraScopesJson);
    let created: {
      conversation: Conversation;
      branch: ConversationBranch;
      agent: Agent;
      session: Session;
    };
    try {
      created = this.deps.storage.transaction((tx) => {
        const conversationsRepo = new ConversationsRepo(tx);
        const branchesRepo = new ConversationBranchesRepo(tx);
        const agentsRepo = new AgentsRepo(tx);
        const sessionsRepo = new SessionsRepo(tx);
        const txRequestsRepo = new SubagentCreationRequestsRepo(tx);
        const security = new SecurityService(tx, buildSystemPolicy());

        conversationsRepo.create({
          id: conversationId,
          channelInstanceId: request.channelInstanceId,
          externalChatId: provisioned.externalChatId,
          kind: provisioned.conversationKind,
          title: request.title,
          createdAt: decidedAt,
          updatedAt: decidedAt,
        });

        branchesRepo.create({
          id: branchId,
          conversationId,
          kind: provisioned.conversationKind === "group" ? "group_main" : "dm_main",
          branchKey: "main",
          createdAt: decidedAt,
          updatedAt: decidedAt,
        });

        agentsRepo.create({
          id: agentId,
          conversationId,
          mainAgentId: request.sourceAgentId,
          kind: "sub",
          displayName: request.title,
          description: request.description,
          workdir: request.workdir,
          createdAt: decidedAt,
        });

        sessionsRepo.create({
          id: sessionId,
          conversationId,
          branchId,
          ownerAgentId: agentId,
          purpose: "chat",
          createdAt: decidedAt,
          updatedAt: decidedAt,
        });

        const initialScopes = buildInitialSubagentScopes({
          workdir: request.workdir,
          initialExtraScopes,
        });
        if (initialScopes.length > 0) {
          security.grantScopes({
            ownerAgentId: agentId,
            scopes: initialScopes,
            grantedBy: "main_agent",
            createdAt: decidedAt,
          });
        }

        new ChannelSurfacesRepo(tx).upsert({
          id: randomUUID(),
          channelType: provisioned.channelSurface.channelType,
          channelInstallationId: provisioned.channelSurface.channelInstallationId,
          conversationId,
          branchId,
          surfaceKey: provisioned.channelSurface.surfaceKey,
          surfaceObjectJson: provisioned.channelSurface.surfaceObjectJson,
          createdAt: decidedAt,
          updatedAt: decidedAt,
        });

        txRequestsRepo.updateStatus({
          id: request.id,
          status: "created",
          createdSubagentAgentId: agentId,
          updatedAt: decidedAt,
          decidedAt,
        });

        const conversation = conversationsRepo.getById(conversationId);
        const branch = branchesRepo.getById(branchId);
        const agent = agentsRepo.getById(agentId);
        const session = sessionsRepo.getById(sessionId);
        if (conversation == null || branch == null || agent == null || session == null) {
          throw new Error("Failed to persist the created SubAgent records");
        }

        return {
          conversation,
          branch,
          agent,
          session,
        };
      });
    } catch (error: unknown) {
      const cleanupError = await this.cleanupProvisionedSurface({
        channelInstanceId: request.channelInstanceId,
        externalChatId: provisioned.externalChatId,
      });
      const failureReason = buildSubagentFinalizeFailureReason({
        externalChatId: provisioned.externalChatId,
        error,
        cleanupError,
      });
      this.markRequestFailed({
        requestId: request.id,
        failureReason,
        decidedAt,
      });
      throw new Error(failureReason);
    }

    const kickoffMessage = buildSubagentKickoffMessage(request.initialTask);
    void this.deps.ingress
      .submitMessage({
        sessionId: created.session.id,
        scenario: "chat",
        content: kickoffMessage,
        messageType: "subagent_kickoff",
        visibility: "hidden_system",
        createdAt: decidedAt,
      })
      .catch((error: unknown) => {
        logger.error("failed to start subagent kickoff run", {
          requestId: request.id,
          subagentAgentId: created.agent.id,
          sessionId: created.session.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });

    logger.info("created subagent from approved request", {
      requestId: request.id,
      subagentId: created.agent.id,
      conversationId: created.conversation.id,
      sessionId: created.session.id,
    });

    return {
      ...created,
      externalChatId: provisioned.externalChatId,
      shareLink: provisioned.shareLink,
      workdir: request.workdir,
      privateWorkspaceDir,
    };
  }

  denyCreateRequest(input: DenySubagentCreationRequestInput): SubagentCreationRequest {
    const decidedAt = input.decidedAt ?? new Date();
    const request = this.getPendingRequestOrThrow(input.requestId, decidedAt);
    const repo = new SubagentCreationRequestsRepo(this.deps.storage);
    repo.updateStatus({
      id: request.id,
      status: "denied",
      failureReason: input.reasonText ?? null,
      updatedAt: decidedAt,
      decidedAt,
    });

    const updated = repo.getById(request.id);
    if (updated == null) {
      throw new Error(`SubAgent creation request disappeared after deny: ${request.id}`);
    }
    return updated;
  }

  expireCreateRequest(input: { requestId: string; expiredAt?: Date }): SubagentCreationRequest {
    const expiredAt = input.expiredAt ?? new Date();
    const request = this.getRequestOrThrow(input.requestId);
    if (request.status !== "pending") {
      return request;
    }

    const repo = new SubagentCreationRequestsRepo(this.deps.storage);
    repo.updateStatus({
      id: request.id,
      status: "expired",
      updatedAt: expiredAt,
      decidedAt: expiredAt,
    });

    const updated = repo.getById(request.id);
    if (updated == null) {
      throw new Error(`SubAgent creation request disappeared after expire: ${request.id}`);
    }
    return updated;
  }

  private getPendingRequestOrThrow(requestId: string, now: Date): SubagentCreationRequest {
    const request = this.getRequestOrThrow(requestId);
    if (request.status !== "pending") {
      throw new Error(`SubAgent creation request ${requestId} is already ${request.status}`);
    }

    if (request.expiresAt != null && Date.parse(request.expiresAt) <= now.getTime()) {
      new SubagentCreationRequestsRepo(this.deps.storage).updateStatus({
        id: request.id,
        status: "expired",
        updatedAt: now,
        decidedAt: now,
      });
      throw new Error(`SubAgent creation request ${requestId} has expired`);
    }

    return request;
  }

  private getRequestOrThrow(requestId: string): SubagentCreationRequest {
    const request = new SubagentCreationRequestsRepo(this.deps.storage).getById(requestId);
    if (request == null) {
      throw new Error(`Unknown SubAgent creation request ${requestId}`);
    }

    return request;
  }

  private resolveValidatedMainChatSource(sessionId: string): {
    session: Session;
    mainAgent: Agent;
    conversation: Conversation;
  } {
    const sessionsRepo = new SessionsRepo(this.deps.storage);
    const agentsRepo = new AgentsRepo(this.deps.storage);
    const conversationsRepo = new ConversationsRepo(this.deps.storage);
    const session = sessionsRepo.getById(sessionId);
    if (session == null) {
      throw new Error(`SubAgent creation requires an existing source session: ${sessionId}`);
    }
    if (session.purpose !== "chat") {
      throw new Error("SubAgent creation is only allowed from a main-agent chat session");
    }
    if (session.ownerAgentId == null) {
      throw new Error("SubAgent creation requires a source session owned by the main agent");
    }

    const mainAgent = agentsRepo.getById(session.ownerAgentId);
    if (mainAgent == null || mainAgent.kind !== "main") {
      throw new Error("SubAgent creation is only allowed from a main-agent chat session");
    }

    const conversation = conversationsRepo.getById(session.conversationId);
    if (conversation == null) {
      throw new Error(`Source conversation not found: ${session.conversationId}`);
    }

    return {
      session,
      mainAgent,
      conversation,
    };
  }

  private requireProvisioner(): SubagentConversationSurfaceProvisioner {
    if (this.deps.provisioner == null) {
      throw new Error(
        "Cannot provision subagent conversations without a configured surface provisioner",
      );
    }

    return this.deps.provisioner;
  }

  private markRequestFailed(input: {
    requestId: string;
    failureReason: string;
    decidedAt: Date;
  }): SubagentCreationRequest {
    const repo = new SubagentCreationRequestsRepo(this.deps.storage);
    repo.updateStatus({
      id: input.requestId,
      status: "failed",
      failureReason: input.failureReason,
      updatedAt: input.decidedAt,
      decidedAt: input.decidedAt,
    });

    const updated = repo.getById(input.requestId);
    if (updated == null) {
      throw new Error(`SubAgent creation request disappeared after failure: ${input.requestId}`);
    }

    return updated;
  }

  private async cleanupProvisionedSurface(input: {
    channelInstanceId: string;
    externalChatId: string;
  }): Promise<string | null> {
    if (this.deps.provisioner?.cleanupProvisionedSubagentSurface == null) {
      logger.error("subagent surface cleanup unavailable after finalize failure", {
        channelInstanceId: input.channelInstanceId,
        externalChatId: input.externalChatId,
      });
      return "surface provisioner does not support cleanup";
    }

    try {
      await this.deps.provisioner.cleanupProvisionedSubagentSurface({
        channelInstanceId: input.channelInstanceId,
        externalChatId: input.externalChatId,
      });
      return null;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("failed to cleanup provisioned subagent surface after finalize error", {
        channelInstanceId: input.channelInstanceId,
        externalChatId: input.externalChatId,
        error: message,
      });
      return message;
    }
  }

  private async ensurePrivateWorkspaceDir(path: string): Promise<void> {
    if (this.deps.privateWorkspace != null) {
      await this.deps.privateWorkspace.ensureDirectory(path);
      return;
    }

    await mkdir(path, { recursive: true });
  }
}

export function buildSubagentKickoffMessage(initialTask: string): string {
  return [
    "<subagent_kickoff>",
    "This is a system-generated kickoff note for a newly created SubAgent conversation.",
    "It provides background about why this SubAgent was created.",
    "It is not a literal user message in this chat, and it does not mean every detail is already confirmed.",
    "",
    initialTask.trim(),
    "",
    "If the task is already specific enough to execute, start the work.",
    "If the request is still broad, ambiguous, or missing key decisions, begin by greeting the user in this new conversation and asking the focused follow-up questions you need.",
    "Do not invent missing requirements or pretend your guesses were already approved by the user.",
    "</subagent_kickoff>",
  ].join("\n");
}

function buildInitialSubagentScopes(input: {
  workdir: string;
  initialExtraScopes: PermissionScope[];
}): PermissionScope[] {
  const repoLocalSkillDirs = resolveRepoLocalSkillDirs(input.workdir);
  const repoLocalSkillScopes =
    repoLocalSkillDirs == null
      ? []
      : [repoLocalSkillDirs.agentsSkillsDir, repoLocalSkillDirs.claudeSkillsDir].map(
          (rootDir) =>
            ({
              kind: "fs.read" as const,
              path: toSubtreePath(rootDir),
            }) satisfies PermissionScope,
        );
  const scopes: PermissionScope[] = [...repoLocalSkillScopes];

  if (!isPathWithinOrEqual(input.workdir, POKOCLAW_WORKSPACE_DIR)) {
    scopes.push(
      { kind: "fs.read", path: toSubtreePath(input.workdir) },
      { kind: "fs.write", path: toSubtreePath(input.workdir) },
    );
  }

  scopes.push(...dedupeScopes(input.initialExtraScopes));
  return scopes;
}

function normalizeSubagentWorkdir(cwd: string | undefined, fallbackWorkdir: string): string {
  const candidate = cwd == null || cwd.trim().length === 0 ? fallbackWorkdir : cwd.trim();
  const normalized = path.normalize(candidate);

  if (!path.isAbsolute(normalized)) {
    throw new Error(`SubAgent workdir must be an absolute path: ${candidate}`);
  }
  if (normalized === path.parse(normalized).root) {
    throw new Error("SubAgent workdir must not be the filesystem root");
  }
  if (isPathWithinOrEqual(normalized, POKOCLAW_SYSTEM_DIR)) {
    throw new Error(`SubAgent workdir must not target the protected system area: ${normalized}`);
  }

  return normalized;
}

function normalizeRequiredTrimmed(field: string, value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }

  return normalized;
}

function toSubtreePath(targetPath: string): string {
  return appendFsSubtreeSuffix(targetPath);
}

function buildSubagentFinalizeFailureReason(input: {
  externalChatId: string;
  error: unknown;
  cleanupError: string | null;
}): string {
  const base = input.error instanceof Error ? input.error.message : String(input.error);
  if (input.cleanupError == null) {
    return `Failed to finalize SubAgent creation after provisioning external chat ${input.externalChatId}; cleanup succeeded: ${base}`;
  }

  return `Failed to finalize SubAgent creation after provisioning external chat ${input.externalChatId}; cleanup also failed (${input.cleanupError}): ${base}`;
}

function isPathWithinOrEqual(targetPath: string, parentPath: string): boolean {
  const relative = path.relative(parentPath, targetPath);
  return relative.length === 0 || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function dedupeScopes(scopes: PermissionScope[]): PermissionScope[] {
  const unique = new Map<string, PermissionScope>();

  for (const scope of scopes) {
    if ("path" in scope) {
      unique.set(`${scope.kind}:${scope.path}`, scope);
      continue;
    }
    if ("prefix" in scope) {
      unique.set(`${scope.kind}:${scope.prefix.join("\u0000")}`, scope);
      continue;
    }
    unique.set(`${scope.kind}:${scope.database}`, scope);
  }

  return [...unique.values()];
}

function serializePermissionScopes(scopes: PermissionScope[]): string {
  return JSON.stringify(scopes.map((scope) => JSON.parse(serializePermissionScope(scope))));
}

function parseSerializedPermissionScopes(input: string): PermissionScope[] {
  const parsed = JSON.parse(input) as PermissionScope[];
  return dedupeScopes(parsed);
}
