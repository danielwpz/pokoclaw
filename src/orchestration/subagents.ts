import { randomUUID } from "node:crypto";
import path from "node:path";

import { buildSystemPolicy } from "@/src/security/policy.js";
import { type PermissionScope, serializePermissionScope } from "@/src/security/scope.js";
import { SecurityService } from "@/src/security/service.js";
import { createSubsystemLogger } from "@/src/shared/logger.js";
import { POKECLAW_SYSTEM_DIR, POKECLAW_WORKSPACE_DIR } from "@/src/shared/paths.js";
import type { StorageDb } from "@/src/storage/db/client.js";
import { AgentsRepo } from "@/src/storage/repos/agents.repo.js";
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
  preferredSurface: "independent_chat";
}

export type ProvisionSubagentSurfaceResult =
  | {
      status: "provisioned";
      externalChatId: string;
      conversationKind: "dm" | "group";
    }
  | {
      status: "failed";
      reason: string;
      retryable: boolean;
    };

export interface SubagentConversationSurfaceProvisioner {
  provisionSubagentSurface(
    input: ProvisionSubagentSurfaceInput,
  ): Promise<ProvisionSubagentSurfaceResult>;
}

export interface SubagentManagerIngress {
  submitMessage(input: {
    sessionId: string;
    scenario: "subagent";
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
  workdir: string;
}

export interface SubagentManagerDependencies {
  storage: StorageDb;
  ingress: SubagentManagerIngress;
  provisioner?: SubagentConversationSurfaceProvisioner;
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
    const workdir = normalizeSubagentWorkdir(input.cwd);
    const initialExtraScopes = dedupeScopes(input.initialExtraScopes ?? []);
    const requestId = randomUUID();

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
      initialExtraScopes,
    };
  }

  async approveCreateRequest(input: ApproveSubagentCreationRequestInput): Promise<CreatedSubagent> {
    const decidedAt = input.decidedAt ?? new Date();
    const request = this.getPendingRequestOrThrow(input.requestId, decidedAt);
    const provisioner = this.requireProvisioner();

    const conversationId = randomUUID();
    const branchId = randomUUID();
    const agentId = randomUUID();
    const sessionId = randomUUID();

    const provisioned = await provisioner.provisionSubagentSurface({
      conversationId,
      sourceConversationId: request.sourceConversationId,
      channelInstanceId: request.channelInstanceId,
      title: request.title,
      preferredSurface: "independent_chat",
    });

    if (provisioned.status !== "provisioned") {
      new SubagentCreationRequestsRepo(this.deps.storage).updateStatus({
        id: request.id,
        status: "failed",
        failureReason: provisioned.reason,
        updatedAt: decidedAt,
        decidedAt,
      });
      throw new Error(
        `Failed to provision the SubAgent conversation surface: ${provisioned.reason}`,
      );
    }

    const initialExtraScopes = parseSerializedPermissionScopes(request.initialExtraScopesJson);
    const created = this.deps.storage.transaction((tx) => {
      const conversationsRepo = new ConversationsRepo(tx);
      const branchesRepo = new ConversationBranchesRepo(tx);
      const agentsRepo = new AgentsRepo(tx);
      const sessionsRepo = new SessionsRepo(tx);
      const requestsRepo = new SubagentCreationRequestsRepo(tx);
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

      requestsRepo.updateStatus({
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

    const kickoffMessage = buildSubagentKickoffMessage(request.initialTask);
    void this.deps.ingress
      .submitMessage({
        sessionId: created.session.id,
        scenario: "subagent",
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
      workdir: request.workdir,
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
}

export function buildSubagentKickoffMessage(initialTask: string): string {
  return [
    "<subagent_kickoff>",
    "This is a system-generated kickoff instruction for the task you should begin now.",
    "It is not a literal user message in this chat.",
    "",
    initialTask.trim(),
    "",
    "Reply to the user in this conversation to begin the task.",
    "</subagent_kickoff>",
  ].join("\n");
}

function buildInitialSubagentScopes(input: {
  workdir: string;
  initialExtraScopes: PermissionScope[];
}): PermissionScope[] {
  const scopes: PermissionScope[] = [];

  if (!isPathWithinOrEqual(input.workdir, POKECLAW_WORKSPACE_DIR)) {
    scopes.push(
      { kind: "fs.read", path: toSubtreePath(input.workdir) },
      { kind: "fs.write", path: toSubtreePath(input.workdir) },
    );
  }

  scopes.push(...dedupeScopes(input.initialExtraScopes));
  return scopes;
}

function normalizeSubagentWorkdir(cwd: string | undefined): string {
  const candidate = cwd == null || cwd.trim().length === 0 ? POKECLAW_WORKSPACE_DIR : cwd.trim();
  const normalized = path.normalize(candidate);

  if (!path.isAbsolute(normalized)) {
    throw new Error(`SubAgent workdir must be an absolute path: ${candidate}`);
  }
  if (normalized === path.parse(normalized).root) {
    throw new Error("SubAgent workdir must not be the filesystem root");
  }
  if (isPathWithinOrEqual(normalized, POKECLAW_SYSTEM_DIR)) {
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
  return path.join(targetPath, "**");
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
