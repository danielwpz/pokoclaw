import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import {
  buildEffectivePermissions,
  checkBashFullAccessPermission,
  checkDatabasePermission,
  checkFilesystemPermission,
  type EffectivePermissions,
  type PermissionCheckResult,
  parseGrantedScopes,
} from "@/src/security/permissions.js";
import {
  type AgentRuntimeRole,
  buildAgentPermissionBaseline,
  buildSystemPolicy,
  normalizeAgentKindToRuntimeRole,
  type SystemPermissionPolicy,
} from "@/src/security/policy.js";
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
import { agents } from "@/src/storage/schema/tables.js";
import type { AgentPermissionGrant, ApprovalRecord } from "@/src/storage/schema/types.js";

const logger = createSubsystemLogger("security");

export class SecurityService {
  private readonly approvalsRepo: ApprovalsRepo;
  private readonly grantsRepo: PermissionGrantsRepo;
  private readonly db: StorageDb;

  constructor(
    db: StorageDb,
    private readonly systemPolicy: SystemPermissionPolicy = buildSystemPolicy(),
  ) {
    this.db = db;
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
    return this.buildEffectivePermissionsForScopes(ownerAgentId, scopes);
  }

  getEffectivePermissionsWithEphemeralScopes(input: {
    ownerAgentId: string;
    activeAt?: Date;
    ephemeralScopes?: PermissionScope[];
  }): EffectivePermissions {
    const grants = this.grantsRepo.listActiveByOwner(input.ownerAgentId, input.activeAt);
    const scopes = [
      ...parseGrantedScopes(grants.map((grant) => grant.scopeJson)),
      ...(input.ephemeralScopes ?? []),
    ];
    return this.buildEffectivePermissionsForScopes(input.ownerAgentId, scopes);
  }

  private buildEffectivePermissionsForScopes(
    ownerAgentId: string,
    scopes: PermissionScope[],
  ): EffectivePermissions {
    return buildEffectivePermissions(
      scopes,
      this.systemPolicy,
      buildAgentPermissionBaseline(this.getAgentRole(ownerAgentId)),
    );
  }

  checkFilesystemAccess(input: {
    ownerAgentId: string;
    kind: FsPermissionKind;
    targetPath: string;
    cwd?: string;
    activeAt?: Date;
    ephemeralScopes?: PermissionScope[];
  }): PermissionCheckResult {
    return checkFilesystemPermission({
      kind: input.kind,
      targetPath: input.targetPath,
      permissions: this.getEffectivePermissionsWithEphemeralScopes({
        ownerAgentId: input.ownerAgentId,
        ...(input.activeAt == null ? {} : { activeAt: input.activeAt }),
        ...(input.ephemeralScopes == null ? {} : { ephemeralScopes: input.ephemeralScopes }),
      }),
      ...(input.cwd == null ? {} : { cwd: input.cwd }),
    });
  }

  checkDatabaseAccess(input: {
    ownerAgentId: string;
    kind: DbPermissionKind;
    activeAt?: Date;
    ephemeralScopes?: PermissionScope[];
  }): PermissionCheckResult {
    return checkDatabasePermission({
      kind: input.kind,
      permissions: this.getEffectivePermissionsWithEphemeralScopes({
        ownerAgentId: input.ownerAgentId,
        ...(input.activeAt == null ? {} : { activeAt: input.activeAt }),
        ...(input.ephemeralScopes == null ? {} : { ephemeralScopes: input.ephemeralScopes }),
      }),
    });
  }

  checkBashFullAccess(input: {
    ownerAgentId: string;
    commandPrefix: string[];
    activeAt?: Date;
    ephemeralScopes?: PermissionScope[];
  }): PermissionCheckResult {
    return checkBashFullAccessPermission({
      commandPrefix: input.commandPrefix,
      permissions: this.getEffectivePermissionsWithEphemeralScopes({
        ownerAgentId: input.ownerAgentId,
        ...(input.activeAt == null ? {} : { activeAt: input.activeAt }),
        ...(input.ephemeralScopes == null ? {} : { ephemeralScopes: input.ephemeralScopes }),
      }),
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
    const normalizedScopes =
      input.grantedBy === "user"
        ? expandUserApprovedFilesystemScopes(input.scopes)
        : dedupeScopes(input.scopes);
    const grantIds: string[] = [];

    for (const scope of normalizedScopes) {
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

  getAgentRole(ownerAgentId: string): AgentRuntimeRole {
    const row =
      this.db.select({ kind: agents.kind }).from(agents).where(eq(agents.id, ownerAgentId)).get() ??
      null;

    return normalizeAgentKindToRuntimeRole(row?.kind);
  }
}

function describeScopeForLog(scope: PermissionScope): string {
  if ("path" in scope) {
    return `${scope.kind}:${scope.path}`;
  }

  if ("prefix" in scope) {
    return `${scope.kind}:${scope.prefix.join(" ")}`;
  }

  return `${scope.kind}:${scope.database}`;
}

function expandUserApprovedFilesystemScopes(scopes: PermissionScope[]): PermissionScope[] {
  const expanded = new Map<string, PermissionScope>();

  for (const scope of scopes) {
    if ("path" in scope) {
      expanded.set(`fs.read:${scope.path}`, { kind: "fs.read", path: scope.path });
      expanded.set(`fs.write:${scope.path}`, { kind: "fs.write", path: scope.path });
      continue;
    }

    if ("prefix" in scope) {
      expanded.set(`${scope.kind}:${scope.prefix.join("\u0000")}`, scope);
      continue;
    }

    expanded.set(`${scope.kind}:${scope.database}`, scope);
  }

  return [...expanded.values()];
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
