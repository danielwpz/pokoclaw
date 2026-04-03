import path from "node:path";

export type FsPermissionKind = "fs.read" | "fs.write";
export type DbPermissionKind = "db.read" | "db.write";
export type BashPermissionKind = "bash.full_access";
export type PermissionKind = FsPermissionKind | DbPermissionKind | BashPermissionKind;

export interface FsPermissionScope {
  kind: FsPermissionKind;
  path: string;
}

export interface DbPermissionScope {
  kind: DbPermissionKind;
  database: "system";
}

export interface BashFullAccessScope {
  kind: BashPermissionKind;
  prefix: string[];
}

export type PermissionScope = FsPermissionScope | DbPermissionScope | BashFullAccessScope;

export interface PermissionRequest {
  scopes: PermissionScope[];
}

const GLOB_CHARS = /[*?[\]]/;
const SUBTREE_SUFFIX = "/**";

function assertObject(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }

  return value as Record<string, unknown>;
}

function assertString(value: unknown, context: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${context} must be a non-empty string`);
  }

  return value;
}

function validateFsScopePath(value: unknown, context: string): string {
  const candidatePath = assertString(value, context);
  if (!path.isAbsolute(candidatePath)) {
    throw new Error(`${context} must be an absolute path`);
  }

  const pathWithoutSubtreeSuffix = candidatePath.endsWith(SUBTREE_SUFFIX)
    ? candidatePath.slice(0, -SUBTREE_SUFFIX.length)
    : candidatePath;

  if (pathWithoutSubtreeSuffix.length === 0) {
    throw new Error(`${context} must not target the filesystem root subtree`);
  }

  if (GLOB_CHARS.test(pathWithoutSubtreeSuffix)) {
    throw new Error(
      `${context} only supports exact absolute paths or paths ending with ${SUBTREE_SUFFIX}`,
    );
  }

  return candidatePath;
}

function parseFsScope(input: Record<string, unknown>, kind: FsPermissionKind): FsPermissionScope {
  return {
    kind,
    path: validateFsScopePath(input.path, `${kind} path`),
  };
}

function parseDbScope(input: Record<string, unknown>, kind: DbPermissionKind): DbPermissionScope {
  const database = assertString(input.database, `${kind} database`);
  if (database !== "system") {
    throw new Error(`${kind} database must be "system"`);
  }

  return {
    kind,
    database,
  };
}

function parseBashScope(input: Record<string, unknown>): BashFullAccessScope {
  const prefix = input.prefix;
  if (!Array.isArray(prefix) || prefix.length === 0) {
    throw new Error("bash.full_access prefix must be a non-empty array");
  }

  const normalizedPrefix = prefix.map((entry, index) =>
    assertString(entry, `bash.full_access prefix[${index}]`).trim(),
  );

  if (normalizedPrefix.some((entry) => entry.length === 0)) {
    throw new Error("bash.full_access prefix entries must be non-empty strings");
  }

  return {
    kind: "bash.full_access",
    prefix: normalizedPrefix,
  };
}

export function parsePermissionScope(input: unknown): PermissionScope {
  const scope = assertObject(input, "permission scope");
  const kind = assertString(scope.kind, "permission scope kind") as PermissionKind;

  switch (kind) {
    case "fs.read":
    case "fs.write":
      return parseFsScope(scope, kind);
    case "db.read":
    case "db.write":
      return parseDbScope(scope, kind);
    case "bash.full_access":
      return parseBashScope(scope);
    default:
      throw new Error(`Unsupported permission scope kind: ${kind}`);
  }
}

export function parsePermissionScopeJson(input: string): PermissionScope {
  try {
    return parsePermissionScope(JSON.parse(input));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid permission scope JSON: ${message}`);
  }
}

export function parsePermissionRequest(input: unknown): PermissionRequest {
  const request = assertObject(input, "permission request");
  if (!Array.isArray(request.scopes) || request.scopes.length === 0) {
    throw new Error("permission request scopes must be a non-empty array");
  }

  return {
    scopes: request.scopes.map((scope, index) =>
      parsePermissionScopeWithContext(scope, `permission request scopes[${index}]`),
    ),
  };
}

function parsePermissionScopeWithContext(input: unknown, context: string): PermissionScope {
  try {
    return parsePermissionScope(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${context}: ${message}`);
  }
}

export function parsePermissionRequestJson(input: string): PermissionRequest {
  try {
    return parsePermissionRequest(JSON.parse(input));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid permission request JSON: ${message}`);
  }
}

export function serializePermissionScope(scope: PermissionScope): string {
  return JSON.stringify(scope);
}

export function serializePermissionRequest(request: PermissionRequest): string {
  return JSON.stringify(request);
}

export function isFsSubtreeScopePath(scopePath: string): boolean {
  return scopePath.endsWith(SUBTREE_SUFFIX);
}

export function describePermissionScope(scope: PermissionScope): string {
  switch (scope.kind) {
    case "fs.read":
      return `Read ${scope.path}`;
    case "fs.write":
      return `Write ${scope.path}`;
    case "db.read":
      return "Read system database";
    case "db.write":
      return "Write system database";
    case "bash.full_access":
      return `Run bash commands with full access for prefix: ${scope.prefix.join(" ")}`;
  }
}

export function describePermissionRequestLines(request: PermissionRequest): string[] {
  return request.scopes.map((scope) => describePermissionScope(scope));
}

export function describePermissionRequest(
  request: PermissionRequest,
  options?: { separator?: string },
): string {
  return describePermissionRequestLines(request).join(options?.separator ?? "; ");
}
