import fs from "node:fs";
import path from "node:path";

import type { SystemPermissionPolicy } from "@/src/security/policy.js";
import { DEFAULT_SYSTEM_POLICY } from "@/src/security/policy.js";
import {
  type DbPermissionKind,
  type FsPermissionKind,
  isFsSubtreeScopePath,
  type PermissionScope,
  parsePermissionScope,
} from "@/src/security/scope.js";

export interface EffectivePermissions {
  fs: {
    read: {
      hardDeny: string[];
      deny: string[];
      allow: string[];
    };
    write: {
      hardDeny: string[];
      deny: string[];
      allow: string[];
    };
  };
  db: {
    read: boolean;
    write: boolean;
  };
}

export type PermissionCheckResult =
  | {
      result: "allow";
      reason: "granted";
      summary: string;
    }
  | {
      result: "deny";
      reason: "hard_deny" | "not_granted";
      summary: string;
    };

function expandHomePrefix(value: string): string {
  if (value === "~") {
    return process.env.HOME ?? value;
  }
  if (value.startsWith("~/")) {
    const homeDir = process.env.HOME;
    return homeDir == null ? value : path.join(homeDir, value.slice(2));
  }
  return value;
}

function normalizePolicyPath(value: string): string {
  const expanded = expandHomePrefix(value);
  if (isFsSubtreeScopePath(expanded)) {
    const basePath = expanded.slice(0, -3);
    return `${resolvePathWithExistingRealpath(basePath)}/**`;
  }
  return resolvePathWithExistingRealpath(expanded);
}

function normalizeCheckedPath(value: string, cwd?: string): string {
  return resolvePathWithExistingRealpath(value, cwd);
}

function matchesPolicyPath(pattern: string, targetPath: string): boolean {
  if (isFsSubtreeScopePath(pattern)) {
    const basePath = pattern.slice(0, -3);
    return targetPath === basePath || targetPath.startsWith(`${basePath}${path.sep}`);
  }

  return targetPath === pattern;
}

function getFsAllowPaths(scopes: PermissionScope[], kind: FsPermissionKind): string[] {
  return scopes
    .filter(
      (scope): scope is Extract<PermissionScope, { kind: FsPermissionKind }> => scope.kind === kind,
    )
    .map((scope) => normalizePolicyPath(scope.path));
}

function hasDbGrant(scopes: PermissionScope[], kind: DbPermissionKind): boolean {
  return scopes.some((scope): scope is Extract<PermissionScope, { kind: DbPermissionKind }> => {
    return scope.kind === kind && scope.database === "system";
  });
}

export function buildEffectivePermissions(
  scopes: PermissionScope[],
  systemPolicy: SystemPermissionPolicy = DEFAULT_SYSTEM_POLICY,
): EffectivePermissions {
  return {
    fs: {
      read: {
        hardDeny: systemPolicy.fs.read.hardDeny.map(normalizePolicyPath),
        deny: systemPolicy.fs.read.deny.map(normalizePolicyPath),
        allow: getFsAllowPaths(scopes, "fs.read"),
      },
      write: {
        hardDeny: systemPolicy.fs.write.hardDeny.map(normalizePolicyPath),
        deny: systemPolicy.fs.write.deny.map(normalizePolicyPath),
        allow: getFsAllowPaths(scopes, "fs.write"),
      },
    },
    db: {
      read: systemPolicy.db.read && hasDbGrant(scopes, "db.read"),
      write: systemPolicy.db.write && hasDbGrant(scopes, "db.write"),
    },
  };
}

function hasPolicyMatch(patterns: string[], targetPath: string): boolean {
  return patterns.some((pattern) => matchesPolicyPath(pattern, targetPath));
}

export function checkFilesystemPermission(input: {
  kind: FsPermissionKind;
  targetPath: string;
  cwd?: string;
  permissions: EffectivePermissions;
}): PermissionCheckResult {
  const normalizedTargetPath = normalizeCheckedPath(input.targetPath, input.cwd);
  const rules = input.kind === "fs.read" ? input.permissions.fs.read : input.permissions.fs.write;

  if (hasPolicyMatch(rules.hardDeny, normalizedTargetPath)) {
    return {
      result: "deny",
      reason: "hard_deny",
      summary: `${input.kind} is blocked by system policy for ${normalizedTargetPath}`,
    };
  }

  const allowMatch = hasPolicyMatch(rules.allow, normalizedTargetPath);
  const denyMatch = hasPolicyMatch(rules.deny, normalizedTargetPath);

  if (input.kind === "fs.read" && denyMatch && allowMatch) {
    return {
      result: "allow",
      reason: "granted",
      summary: `Read access granted for ${normalizedTargetPath}`,
    };
  }

  if (denyMatch) {
    return {
      result: "deny",
      reason: "not_granted",
      summary: `${input.kind} is not granted for ${normalizedTargetPath}`,
    };
  }

  if (allowMatch) {
    return {
      result: "allow",
      reason: "granted",
      summary: `${input.kind} is granted for ${normalizedTargetPath}`,
    };
  }

  return {
    result: "deny",
    reason: "not_granted",
    summary: `${input.kind} requires approval for ${normalizedTargetPath}`,
  };
}

export function checkDatabasePermission(input: {
  kind: DbPermissionKind;
  permissions: EffectivePermissions;
}): PermissionCheckResult {
  const allowed = input.kind === "db.read" ? input.permissions.db.read : input.permissions.db.write;
  if (allowed) {
    return {
      result: "allow",
      reason: "granted",
      summary: `${input.kind} is granted for the system database`,
    };
  }

  return {
    result: "deny",
    reason: "not_granted",
    summary: `${input.kind} requires approval for the system database`,
  };
}

export function parseGrantedScopes(scopeJsonValues: string[]): PermissionScope[] {
  return scopeJsonValues.map((scopeJson) => parsePermissionScope(JSON.parse(scopeJson)));
}

function resolvePathWithExistingRealpath(inputPath: string, cwd?: string): string {
  const absolutePath = path.resolve(cwd ?? process.cwd(), expandHomePrefix(inputPath));
  const normalizedAbsolutePath = path.normalize(absolutePath);

  let probePath = normalizedAbsolutePath;
  let remainder = "";

  while (!fs.existsSync(probePath)) {
    const parentPath = path.dirname(probePath);
    if (parentPath === probePath) {
      return normalizedAbsolutePath;
    }

    remainder =
      remainder.length === 0
        ? path.basename(probePath)
        : path.join(path.basename(probePath), remainder);
    probePath = parentPath;
  }

  let resolvedExistingPath = normalizedAbsolutePath;
  try {
    resolvedExistingPath = fs.realpathSync.native(probePath);
  } catch {
    return normalizedAbsolutePath;
  }

  return remainder.length === 0 ? resolvedExistingPath : path.join(resolvedExistingPath, remainder);
}
