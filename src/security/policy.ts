import os from "node:os";
import path from "node:path";

import type { AppConfig } from "@/src/config/schema.js";
import {
  POKECLAW_REPO_DIR,
  POKECLAW_SKILLS_DIR,
  POKECLAW_SYSTEM_DIR,
  POKECLAW_WORKSPACE_DIR,
} from "@/src/shared/paths.js";

export interface FilesystemPermissionPolicy {
  hardDeny: string[];
  deny: string[];
}

export interface SystemPermissionPolicy {
  fs: {
    read: FilesystemPermissionPolicy;
    write: FilesystemPermissionPolicy;
  };
  network: {
    hardDenyHosts: string[];
  };
  db: {
    read: boolean;
    write: boolean;
  };
}

export type AgentRuntimeRole = "main" | "subagent" | "task";

export interface AgentPermissionBaseline {
  role: AgentRuntimeRole;
  db: {
    read: boolean;
    write: boolean;
  };
  fs: {
    readMode: "allow_only" | "deny_only";
    readAllow: string[];
    writeAllow: string[];
  };
}

function subtree(value: string): string {
  return path.join(value, "**");
}

const HOME_DIR = os.homedir();

export const DEFAULT_FILESYSTEM_HARD_DENY_READ = [
  subtree(POKECLAW_SYSTEM_DIR),
  subtree(path.join("~", ".ssh")),
  subtree(path.join("~", ".gnupg")),
  subtree(path.join("~", ".aws")),
  subtree(path.join("~", ".azure")),
  subtree(path.join("~", ".gcloud")),
  subtree(path.join("~", ".kube")),
  subtree(path.join("~", ".docker")),
] as const;

export const DEFAULT_FILESYSTEM_HARD_DENY_WRITE = [
  subtree(POKECLAW_SYSTEM_DIR),
  subtree(path.join("~", ".ssh")),
  subtree(path.join("~", ".gnupg")),
  subtree(path.join("~", ".aws")),
  subtree(path.join("~", ".azure")),
  subtree(path.join("~", ".gcloud")),
  subtree(path.join("~", ".kube")),
  subtree(path.join("~", ".docker")),
] as const;

export const DEFAULT_NETWORK_HARD_DENY_HOSTS = [
  "169.254.169.254",
  "metadata.google.internal",
  "100.100.100.200",
] as const;

export const DEFAULT_SYSTEM_POLICY: SystemPermissionPolicy = buildSystemPolicy();

export function buildSystemPolicy(config?: Pick<AppConfig, "security">): SystemPermissionPolicy {
  const security = config?.security;

  return {
    fs: {
      read: {
        hardDeny: mergeHardDenyList({
          defaults: DEFAULT_FILESYSTEM_HARD_DENY_READ,
          additions: security?.filesystem.hardDenyRead ?? [],
          override: security?.filesystem.overrideHardDenyRead ?? false,
        }),
        deny: [],
      },
      write: {
        hardDeny: mergeHardDenyList({
          defaults: DEFAULT_FILESYSTEM_HARD_DENY_WRITE,
          additions: security?.filesystem.hardDenyWrite ?? [],
          override: security?.filesystem.overrideHardDenyWrite ?? false,
        }),
        deny: [],
      },
    },
    network: {
      hardDenyHosts: mergeHardDenyList({
        defaults: DEFAULT_NETWORK_HARD_DENY_HOSTS,
        additions: security?.network.hardDenyHosts ?? [],
        override: security?.network.overrideHardDenyHosts ?? false,
      }),
    },
    db: {
      read: true,
      write: true,
    },
  };
}

export function buildAgentPermissionBaseline(role: AgentRuntimeRole): AgentPermissionBaseline {
  switch (role) {
    case "main":
      return {
        role,
        db: {
          read: true,
          write: false,
        },
        fs: {
          readMode: "allow_only",
          readAllow: [
            subtree(HOME_DIR),
            subtree(POKECLAW_WORKSPACE_DIR),
            subtree(POKECLAW_SKILLS_DIR),
            subtree(POKECLAW_REPO_DIR),
          ],
          writeAllow: [subtree(POKECLAW_WORKSPACE_DIR)],
        },
      };
    case "subagent":
    case "task":
      return {
        role,
        db: {
          read: false,
          write: false,
        },
        fs: {
          readMode: "allow_only",
          readAllow: [
            subtree(POKECLAW_WORKSPACE_DIR),
            subtree(POKECLAW_SKILLS_DIR),
            subtree(POKECLAW_REPO_DIR),
          ],
          writeAllow: [subtree(POKECLAW_WORKSPACE_DIR)],
        },
      };
  }
}

export function normalizeAgentKindToRuntimeRole(kind: string | null | undefined): AgentRuntimeRole {
  switch (kind) {
    case "main":
      return "main";
    case "task":
      return "task";
    default:
      return "subagent";
  }
}

function mergeHardDenyList(input: {
  defaults: readonly string[];
  additions: string[];
  override: boolean;
}): string[] {
  if (input.override) {
    return dedupePreserveOrder(input.additions);
  }

  return dedupePreserveOrder([...input.defaults, ...input.additions]);
}

function dedupePreserveOrder(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }

  return result;
}
