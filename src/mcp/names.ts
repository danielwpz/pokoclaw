import { createHash } from "node:crypto";

export const MCP_MODEL_TOOL_PREFIX = "mcp";
export const MCP_MODEL_TOOL_DELIMITER = "__";
export const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

const UNSAFE_TOOL_NAME_CHARS = /[^A-Za-z0-9_-]/g;

export function isValidMcpServerName(name: string): boolean {
  return MCP_SERVER_NAME_PATTERN.test(name);
}

export function buildMcpModelToolName(input: {
  serverName: string;
  remoteToolName: string;
  reservedNames: Set<string>;
}): string {
  const baseRemoteName = sanitizeMcpToolNameFragment(input.remoteToolName);
  let candidate = `${MCP_MODEL_TOOL_PREFIX}${MCP_MODEL_TOOL_DELIMITER}${input.serverName}${MCP_MODEL_TOOL_DELIMITER}${baseRemoteName}`;
  if (!input.reservedNames.has(candidate)) {
    input.reservedNames.add(candidate);
    return candidate;
  }

  const hash = createHash("sha256").update(input.remoteToolName).digest("hex").slice(0, 8);
  candidate = `${candidate}_${hash}`;
  let index = 2;
  while (input.reservedNames.has(candidate)) {
    candidate = `${MCP_MODEL_TOOL_PREFIX}${MCP_MODEL_TOOL_DELIMITER}${input.serverName}${MCP_MODEL_TOOL_DELIMITER}${baseRemoteName}_${hash}_${index}`;
    index += 1;
  }

  input.reservedNames.add(candidate);
  return candidate;
}

export function sanitizeMcpToolNameFragment(raw: string): string {
  const normalized = raw.trim().replace(UNSAFE_TOOL_NAME_CHARS, "_");
  return normalized.length > 0 ? normalized : "tool";
}
