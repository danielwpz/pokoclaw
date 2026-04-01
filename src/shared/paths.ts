import { homedir } from "node:os";
import path from "node:path";

export const POKECLAW_HOME_DIR = path.join(homedir(), ".pokeclaw");
export const POKECLAW_SYSTEM_DIR = path.join(POKECLAW_HOME_DIR, "system");
export const POKECLAW_WORKSPACE_DIR = path.join(POKECLAW_HOME_DIR, "workspace");
export const POKECLAW_SUBAGENT_WORKSPACES_DIR = path.join(POKECLAW_WORKSPACE_DIR, "subagents");

export const DEFAULT_CONFIG_TOML_PATH = path.join(POKECLAW_SYSTEM_DIR, "config.toml");
export const DEFAULT_SECRETS_TOML_PATH = path.join(POKECLAW_SYSTEM_DIR, "secrets.toml");
export const CODEX_CREDENTIALS_PATH = path.join(POKECLAW_SYSTEM_DIR, "codex-credentials.json");

export function buildSubagentWorkspaceDir(agentId: string): string {
  const normalized = agentId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  const prefix = normalized.slice(0, 8);
  if (prefix.length === 0) {
    throw new Error(`Cannot derive SubAgent workspace directory from empty agent id: ${agentId}`);
  }

  return path.join(POKECLAW_SUBAGENT_WORKSPACES_DIR, prefix);
}
