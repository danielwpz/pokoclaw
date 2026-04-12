import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const POKOCLAW_HOME_DIR = path.join(homedir(), ".pokoclaw");
export const POKOCLAW_LOGS_DIR = path.join(POKOCLAW_HOME_DIR, "logs");
export const POKOCLAW_SYSTEM_DIR = path.join(POKOCLAW_HOME_DIR, "system");
export const POKOCLAW_WORKSPACE_DIR = path.join(POKOCLAW_HOME_DIR, "workspace");
export const POKOCLAW_SUBAGENT_WORKSPACES_DIR = path.join(POKOCLAW_WORKSPACE_DIR, "subagents");
export const POKOCLAW_SKILLS_DIR = path.join(POKOCLAW_HOME_DIR, "skills");
export const POKOCLAW_REPO_DIR = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
export const POKOCLAW_BUILTIN_SKILLS_DIR = path.join(POKOCLAW_REPO_DIR, "skills");
export const POKOCLAW_RUNTIME_LOG_PATH = path.join(POKOCLAW_LOGS_DIR, "runtime.log");

export const DEFAULT_CONFIG_TOML_PATH = path.join(POKOCLAW_SYSTEM_DIR, "config.toml");
export const DEFAULT_SECRETS_TOML_PATH = path.join(POKOCLAW_SYSTEM_DIR, "secrets.toml");
export const CODEX_CREDENTIALS_PATH = path.join(POKOCLAW_SYSTEM_DIR, "codex-credentials.json");

export function buildSubagentWorkspaceDir(
  agentId: string,
  subagentWorkspacesDir = POKOCLAW_SUBAGENT_WORKSPACES_DIR,
): string {
  const normalized = agentId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  const prefix = normalized.slice(0, 8);
  if (prefix.length === 0) {
    throw new Error(`Cannot derive SubAgent workspace directory from empty agent id: ${agentId}`);
  }

  return path.join(subagentWorkspacesDir, prefix);
}
