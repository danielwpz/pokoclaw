import { randomUUID } from "node:crypto";

import {
  buildEffectivePermissions,
  checkDatabasePermission,
  checkFilesystemPermission,
  type EffectivePermissions,
  type PermissionCheckResult,
  parseGrantedScopes,
} from "@/src/security/permissions.js";
import { DEFAULT_SYSTEM_POLICY, type SystemPermissionPolicy } from "@/src/security/policy.js";
import {
  type DbPermissionKind,
  type FsPermissionKind,
  type PermissionRequest,
  type PermissionScope,
  parsePermissionRequestJson,
  serializePermissionRequest,
  serializePermissionScope,
} from "@/src/security/scope.js";
import { createSubsystemLogger } from "@/src/shared/logger.js";
import type { StorageDb } from "@/src/storage/db/client.js";
import { ApprovalsRepo } from "@/src/storage/repos/approvals.repo.js";
import { PermissionGrantsRepo } from "@/src/storage/repos/permission-grants.repo.js";
import type { AgentPermissionGrant, ApprovalRecord } from "@/src/storage/schema/types.js";

const logger = createSubsystemLogger("security");

export class SecurityService {
  private readonly approvalsRepo: ApprovalsRepo;
  private readonly grantsRepo: PermissionGrantsRepo;

  constructor(
    db: StorageDb,
    private readonly systemPolicy: SystemPermissionPolicy = DEFAULT_SYSTEM_POLICY,
  ) {
    this.approvalsRepo = new ApprovalsRepo(db);
    this.grantsRepo = new PermissionGrantsRepo(db);
  }

  getApprovalById(id: number): ApprovalRecord | null {
    return this.approvalsRepo.getById(id);
  }

  listApprovalsByOwner(ownerAgentId: string, limit?: number): ApprovalRecord[] {
    return this.approvalsRepo.listByOwner(ownerAgentId, limit);
  }

  listApprovalsBySession(
    sessionId: string,
    options?: Parameters<ApprovalsRepo["listBySession"]>[1],
  ): ApprovalRecord[] {
    return this.approvalsRepo.listBySession(sessionId, options);
  }

  listActiveGrants(ownerAgentId: string, activeAt?: Date): AgentPermissionGrant[] {
    return this.grantsRepo.listActiveByOwner(ownerAgentId, activeAt);
  }

  getEffectivePermissions(ownerAgentId: string, activeAt?: Date): EffectivePermissions {
    const grants = this.grantsRepo.listActiveByOwner(ownerAgentId, activeAt);
    const scopes = parseGrantedScopes(grants.map((grant) => grant.scopeJson));
    return buildEffectivePermissions(scopes, this.systemPolicy);
  }

  checkFilesystemAccess(input: {
    ownerAgentId: string;
    kind: FsPermissionKind;
    targetPath: string;
    cwd?: string;
    activeAt?: Date;
  }): PermissionCheckResult {
    return checkFilesystemPermission({
      kind: input.kind,
      targetPath: input.targetPath,
      permissions: this.getEffectivePermissions(input.ownerAgentId, input.activeAt),
      ...(input.cwd == null ? {} : { cwd: input.cwd }),
    });
  }

  checkDatabaseAccess(input: {
    ownerAgentId: string;
    kind: DbPermissionKind;
    activeAt?: Date;
  }): PermissionCheckResult {
    return checkDatabasePermission({
      kind: input.kind,
      permissions: this.getEffectivePermissions(input.ownerAgentId, input.activeAt),
    });
  }

  createApprovalRequest(input: {
    ownerAgentId: string;
    requestedBySessionId?: string | null;
    request: PermissionRequest;
    approvalTarget: "user" | "main_agent";
    reasonText?: string | null;
    expiresAt?: Date | null;
    resumePayloadJson?: string | null;
    createdAt?: Date;
  }): number {
    const approvalId = this.approvalsRepo.create({
      ownerAgentId: input.ownerAgentId,
      requestedBySessionId: input.requestedBySessionId ?? null,
      requestedScopeJson: serializePermissionRequest(input.request),
      approvalTarget: input.approvalTarget,
      status: "pending",
      reasonText: input.reasonText ?? null,
      expiresAt: input.expiresAt ?? null,
      resumePayloadJson: input.resumePayloadJson ?? null,
      ...(input.createdAt == null ? {} : { createdAt: input.createdAt }),
    });
    logger.info("created approval request", {
      approvalId,
      ownerAgentId: input.ownerAgentId,
      sessionId: input.requestedBySessionId ?? null,
      scopeCount: input.request.scopes.length,
      target: input.approvalTarget,
    });
    return approvalId;
  }

  resolveApproval(input: {
    approvalId: number;
    status: "approved" | "denied" | "cancelled";
    reasonText?: string | null;
    decidedAt?: Date;
  }): void {
    logger.info("resolved approval request", {
      approvalId: input.approvalId,
      status: input.status,
    });
    this.approvalsRepo.resolve({
      id: input.approvalId,
      status: input.status,
      reasonText: input.reasonText ?? null,
      ...(input.decidedAt == null ? {} : { decidedAt: input.decidedAt }),
    });
  }

  grantScopes(input: {
    ownerAgentId: string;
    scopes: PermissionScope[];
    grantedBy: "user" | "main_agent";
    sourceApprovalId?: number | null;
    createdAt?: Date;
    expiresAt?: Date | null;
  }): string[] {
    const createdAt = input.createdAt ?? new Date();
    const grantIds: string[] = [];

    for (const scope of input.scopes) {
      const grantId = randomUUID();
      this.grantsRepo.create({
        id: grantId,
        ownerAgentId: input.ownerAgentId,
        sourceApprovalId: input.sourceApprovalId ?? null,
        scopeJson: serializePermissionScope(scope),
        grantedBy: input.grantedBy,
        createdAt,
        expiresAt: input.expiresAt ?? null,
      });
      grantIds.push(grantId);
      logger.info("granted permission scope", {
        grantId,
        ownerAgentId: input.ownerAgentId,
        grantedBy: input.grantedBy,
        scope: describeScopeForLog(scope),
      });
    }

    return grantIds;
  }

  approveRequestAndGrantScopes(input: {
    approvalId: number;
    grantedBy: "user" | "main_agent";
    reasonText?: string | null;
    decidedAt?: Date;
    expiresAt?: Date | null;
  }): string[] {
    const approval = this.approvalsRepo.getById(input.approvalId);
    if (approval == null) {
      throw new Error(`Approval ${input.approvalId} not found`);
    }

    const request = parsePermissionRequestJson(approval.requestedScopeJson);
    const decidedAt = input.decidedAt ?? new Date();

    this.approvalsRepo.resolve({
      id: input.approvalId,
      status: "approved",
      reasonText: input.reasonText ?? null,
      decidedAt,
    });

    return this.grantScopes({
      ownerAgentId: approval.ownerAgentId,
      scopes: request.scopes,
      grantedBy: input.grantedBy,
      sourceApprovalId: approval.id,
      createdAt: decidedAt,
      expiresAt: input.expiresAt ?? null,
    });
  }
}

function describeScopeForLog(scope: PermissionScope): string {
  if ("path" in scope) {
    return `${scope.kind}:${scope.path}`;
  }

  return `${scope.kind}:${scope.database}`;
}
