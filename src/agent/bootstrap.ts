import fs from "node:fs";
import path from "node:path";

import { buildWorkspaceBootstrapPath } from "@/src/memory/files.js";
import { createSubsystemLogger } from "@/src/shared/logger.js";
import { POKOCLAW_WORKSPACE_DIR } from "@/src/shared/paths.js";

const logger = createSubsystemLogger("agent-bootstrap");

export interface AgentBootstrapSnapshot {
  path: string;
  content: string;
  prompt: string;
}

export interface AgentBootstrapResolver {
  resolveForRun(input: {
    sessionPurpose?: string | null;
    agentKind?: string | null;
    workspaceDir?: string | null;
  }): AgentBootstrapSnapshot | null;
}

export class FilesystemAgentBootstrapResolver implements AgentBootstrapResolver {
  resolveForRun(input: {
    sessionPurpose?: string | null;
    agentKind?: string | null;
    workspaceDir?: string | null;
  }): AgentBootstrapSnapshot | null {
    return loadAgentBootstrapSnapshot(input);
  }
}

export function loadAgentBootstrapSnapshot(input: {
  sessionPurpose?: string | null;
  agentKind?: string | null;
  workspaceDir?: string | null;
}): AgentBootstrapSnapshot | null {
  if (input.sessionPurpose !== "chat" || input.agentKind !== "main") {
    return null;
  }

  const workspaceDir = path.resolve(input.workspaceDir ?? POKOCLAW_WORKSPACE_DIR);
  const bootstrapPath = buildWorkspaceBootstrapPath(workspaceDir);

  try {
    if (!fs.existsSync(bootstrapPath)) {
      return null;
    }

    const stat = fs.statSync(bootstrapPath);
    if (!stat.isFile()) {
      return null;
    }

    const content = fs.readFileSync(bootstrapPath, "utf-8").trim();
    if (content.length === 0) {
      return null;
    }

    return {
      path: bootstrapPath,
      content,
      prompt: buildBootstrapPrompt({
        path: bootstrapPath,
        content,
      }),
    };
  } catch (error) {
    logger.warn("bootstrap scan warning", {
      path: bootstrapPath,
      detail: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export function buildBootstrapPrompt(input: { path: string; content: string }): string {
  const lines = [
    "<bootstrap_file>",
    "The file below defines first-run bootstrap instructions for this session.",
    `  <path>${escapeXml(input.path)}</path>`,
    "  <content>",
  ];

  for (const line of input.content.split(/\r?\n/)) {
    lines.push(`    ${escapeXml(line)}`);
  }

  lines.push("  </content>");
  lines.push("</bootstrap_file>");
  return lines.join("\n");
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
