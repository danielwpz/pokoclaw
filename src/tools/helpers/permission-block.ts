import path from "node:path";
import type { PermissionScope } from "@/src/security/scope.js";

export type PermissionResource = "filesystem";
export type PermissionEntryScope = "exact" | "subtree";
export type PermissionAccess = "read" | "write" | "read_write";

export interface PermissionRequestEntry {
  resource: PermissionResource;
  path: string;
  scope: PermissionEntryScope;
  access: PermissionAccess;
}

export interface BashFailureContext {
  command: string;
  cwd: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface PermissionBlockPayload {
  requestable: boolean;
  failedToolCallId?: string;
  summary: string;
  entries: PermissionRequestEntry[];
  guidance?: string;
  bashContext?: BashFailureContext;
}

export interface PermissionDeniedDetails {
  code: "permission_denied";
  requestable: boolean;
  failedToolCallId?: string;
  summary: string;
  entries: PermissionRequestEntry[];
  guidance?: string;
  bashContext?: BashFailureContext;
}

export interface PermissionRequestResultBlockInput {
  status: "approved" | "denied" | "already_granted";
  justification: string;
  retryToolCallId?: string;
  retriedToolName?: string;
}

export function isPermissionDeniedDetails(value: unknown): value is PermissionDeniedDetails {
  if (typeof value !== "object" || value == null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    candidate.code === "permission_denied" &&
    typeof candidate.requestable === "boolean" &&
    typeof candidate.summary === "string" &&
    Array.isArray(candidate.entries)
  );
}

const DEFAULT_REQUESTABLE_GUIDANCE =
  "Review whether this access is necessary and legitimate for the current user request.\nIf it is necessary, call request_permissions.\nIf it is not necessary, do not request permissions.";

const DEFAULT_NON_REQUESTABLE_GUIDANCE =
  "This access is blocked by policy and should not be requested. Choose a different approach.";

export function buildPermissionDeniedDetails(
  payload: PermissionBlockPayload,
): PermissionDeniedDetails {
  return {
    code: "permission_denied",
    requestable: payload.requestable,
    summary: payload.summary,
    entries: payload.entries,
    ...(payload.guidance == null ? {} : { guidance: payload.guidance }),
    ...(payload.failedToolCallId == null ? {} : { failedToolCallId: payload.failedToolCallId }),
    ...(payload.bashContext == null ? {} : { bashContext: payload.bashContext }),
  };
}

export function renderPermissionBlock(payload: PermissionBlockPayload): string {
  const guidance =
    payload.guidance ??
    (payload.requestable ? DEFAULT_REQUESTABLE_GUIDANCE : DEFAULT_NON_REQUESTABLE_GUIDANCE);
  const lines = renderXmlEnvelope("permission_block", [
    ...renderSingleLineElement("requestable", payload.requestable ? "true" : "false"),
    ...(payload.failedToolCallId == null
      ? []
      : renderSingleLineElement("failed_tool_call_id", escapeXmlText(payload.failedToolCallId))),
    "",
    ...renderMultilineElement("summary", escapeXmlText(payload.summary)),
    "",
    ...renderRequiredPermissionsBlock(payload.entries),
    "",
    ...renderMultilineElement("guidance", escapeXmlText(guidance)),
  ]);

  if (payload.bashContext == null) {
    return lines;
  }

  return `${lines}\n\n${renderBashResultBlock(payload.bashContext)}`;
}

export function renderBashResultBlock(input: BashFailureContext): string {
  const signalText = input.signal == null ? "" : input.signal;

  return [
    "<bash_result>",
    `  <command>${escapeXmlText(input.command)}</command>`,
    `  <cwd>${escapeXmlText(input.cwd)}</cwd>`,
    `  <exit_code>${input.exitCode == null ? "" : String(input.exitCode)}</exit_code>`,
    `  <signal>${escapeXmlText(signalText)}</signal>`,
    "",
    "  <stdout>",
    `    ${indentXmlText(input.stdout, 4)}`,
    "  </stdout>",
    "",
    "  <stderr>",
    `    ${indentXmlText(input.stderr, 4)}`,
    "  </stderr>",
    "</bash_result>",
  ].join("\n");
}

export function renderPermissionRequestResultBlock(
  input: PermissionRequestResultBlockInput,
): string {
  return renderXmlEnvelope("permission_request_result", [
    ...renderSingleLineElement("status", input.status),
    "",
    ...renderMultilineElement("justification", escapeXmlText(input.justification)),
    ...(input.retryToolCallId == null
      ? []
      : [
          "",
          ...renderSingleLineElement("retry_tool_call_id", escapeXmlText(input.retryToolCallId)),
        ]),
    ...(input.retriedToolName == null
      ? []
      : renderSingleLineElement("retried_tool_name", escapeXmlText(input.retriedToolName))),
  ]);
}

export function renderPermissionRetryDivider(): string {
  return "---\nbelow are raw outputs from retried tool call:\n---";
}

export function renderPermissionRetryNewBoundaryNote(): string {
  return "The retried tool call hit a new permission boundary. Review the new permission block before requesting more access.";
}

export function compressPermissionScopesToEntries(
  scopes: PermissionScope[],
): PermissionRequestEntry[] {
  const byPath = new Map<
    string,
    {
      read: boolean;
      write: boolean;
    }
  >();

  for (const scope of scopes) {
    if (!("path" in scope)) {
      continue;
    }

    const entry = byPath.get(scope.path) ?? { read: false, write: false };
    if (scope.kind === "fs.read") {
      entry.read = true;
    } else if (scope.kind === "fs.write") {
      entry.write = true;
    }
    byPath.set(scope.path, entry);
  }

  return [...byPath.entries()].map(([scopePath, access]) => ({
    resource: "filesystem",
    path: scopePath.endsWith("/**") ? scopePath.slice(0, -3) : scopePath,
    scope: scopePath.endsWith("/**") ? "subtree" : "exact",
    access: access.read && access.write ? "read_write" : access.read ? "read" : "write",
  }));
}

export function expandPermissionEntriesToScopes(
  entries: PermissionRequestEntry[],
): PermissionScope[] {
  const scopes: PermissionScope[] = [];

  for (const entry of entries) {
    const scopePath = entry.scope === "subtree" ? path.join(entry.path, "**") : entry.path;
    if (entry.access === "read" || entry.access === "read_write") {
      scopes.push({ kind: "fs.read", path: scopePath });
    }
    if (entry.access === "write" || entry.access === "read_write") {
      scopes.push({ kind: "fs.write", path: scopePath });
    }
  }

  return scopes;
}

function renderRequiredPermissionsBlock(entries: PermissionRequestEntry[]): string[] {
  return [
    "  <required_permissions>",
    ...entries.flatMap((entry) => [
      "    <entry>",
      ...renderSingleLineElement("resource", entry.resource, 6),
      ...renderSingleLineElement("path", escapeXmlText(entry.path), 6),
      ...renderSingleLineElement("scope", entry.scope, 6),
      ...renderSingleLineElement("access", entry.access, 6),
      "    </entry>",
    ]),
    "  </required_permissions>",
  ];
}

function renderXmlEnvelope(tagName: string, bodyLines: string[]): string {
  return [`<${tagName}>`, ...bodyLines, `</${tagName}>`].join("\n");
}

function renderSingleLineElement(tagName: string, value: string, indent = 2): string[] {
  const prefix = " ".repeat(indent);
  return [`${prefix}<${tagName}>${value}</${tagName}>`];
}

function renderMultilineElement(
  tagName: string,
  value: string,
  indent = 2,
  contentIndent = indent + 2,
): string[] {
  const prefix = " ".repeat(indent);
  return [`${prefix}<${tagName}>`, indentText(value, contentIndent), `${prefix}</${tagName}>`];
}

function indentText(text: string, spaces: number): string {
  const prefix = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

export function summarizePermissionEntries(entries: PermissionRequestEntry[]): string {
  if (entries.length === 1 && entries[0] != null) {
    const entry = entries[0];
    return `${describeEntryAccess(entry.access)} access is missing for ${entry.path}`;
  }

  return entries
    .map((entry) => `${describeEntryAccess(entry.access)} ${describeEntryScope(entry)}`)
    .join("; ");
}

function describeEntryAccess(access: PermissionAccess): string {
  switch (access) {
    case "read":
      return "Read";
    case "write":
      return "Write";
    case "read_write":
      return "Read/write";
  }
}

function describeEntryScope(entry: PermissionRequestEntry): string {
  return entry.scope === "subtree" ? `${entry.path}/**` : entry.path;
}

function escapeXmlText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function indentXmlText(value: string, spaces: number): string {
  const prefix = " ".repeat(spaces);
  const normalized = value.length === 0 ? "" : escapeXmlText(value);
  return normalized.split("\n").join(`\n${prefix}`);
}
