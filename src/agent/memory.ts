import fs from "node:fs";

import {
  type AgentMemoryFileDescriptor,
  ensureAgentMemoryFiles,
  resolveAgentMemoryFileDescriptors,
} from "@/src/memory/files.js";
import { createSubsystemLogger } from "@/src/shared/logger.js";

const logger = createSubsystemLogger("agent-memory");

export interface AgentMemoryCatalogEntry extends AgentMemoryFileDescriptor {
  content: string;
}

export interface AgentMemoryCatalogWarning {
  path: string;
  reason: "memory_file_not_readable";
  detail?: string;
}

export interface AgentMemoryCatalogSnapshot {
  entries: AgentMemoryCatalogEntry[];
  prompt: string;
  warnings: AgentMemoryCatalogWarning[];
}

export interface AgentMemoryResolver {
  resolveForRun(input: {
    agentKind?: string | null;
    workspaceDir?: string | null;
    privateWorkspaceDir?: string | null;
  }): AgentMemoryCatalogSnapshot;
}

export class FilesystemAgentMemoryResolver implements AgentMemoryResolver {
  resolveForRun(input: {
    agentKind?: string | null;
    workspaceDir?: string | null;
    privateWorkspaceDir?: string | null;
  }): AgentMemoryCatalogSnapshot {
    ensureAgentMemoryFiles(input);
    const snapshot = loadAgentMemoryCatalog(input);

    for (const warning of snapshot.warnings) {
      logger.warn("memory scan warning", {
        path: warning.path,
        reason: warning.reason,
        detail: warning.detail,
      });
    }

    return snapshot;
  }
}

export function loadAgentMemoryCatalog(input: {
  agentKind?: string | null;
  workspaceDir?: string | null;
  privateWorkspaceDir?: string | null;
}): AgentMemoryCatalogSnapshot {
  const warnings: AgentMemoryCatalogWarning[] = [];
  const entries = resolveAgentMemoryFileDescriptors(input).flatMap((descriptor) => {
    const entry = loadMemoryEntry(descriptor, warnings);
    return entry == null ? [] : [entry];
  });

  return {
    entries,
    prompt: buildMemoryCatalogPrompt(entries),
    warnings,
  };
}

export function buildMemoryCatalogPrompt(entries: AgentMemoryCatalogEntry[]): string {
  if (entries.length === 0) {
    return "";
  }

  const lines = [
    "<memory_files>",
    "The files below are durable memory for this session. They are injected context, not user-visible output.",
  ];

  for (const entry of entries) {
    lines.push("  <memory_file>");
    lines.push(`    <layer>${escapeXml(entry.layer)}</layer>`);
    lines.push(`    <purpose>${escapeXml(entry.purpose)}</purpose>`);
    lines.push(`    <path>${escapeXml(entry.path)}</path>`);
    lines.push("    <content>");
    for (const line of entry.content.split(/\r?\n/)) {
      lines.push(`      ${escapeXml(line)}`);
    }
    lines.push("    </content>");
    lines.push("  </memory_file>");
  }

  lines.push("</memory_files>");
  return lines.join("\n");
}

function loadMemoryEntry(
  descriptor: AgentMemoryFileDescriptor,
  warnings: AgentMemoryCatalogWarning[],
): AgentMemoryCatalogEntry | null {
  try {
    if (!fs.existsSync(descriptor.path)) {
      return null;
    }

    const stat = fs.statSync(descriptor.path);
    if (!stat.isFile()) {
      return null;
    }

    const content = fs.readFileSync(descriptor.path, "utf-8").trim();
    if (content.length === 0) {
      return null;
    }

    return {
      layer: descriptor.layer,
      path: descriptor.path,
      purpose: descriptor.purpose,
      content,
    };
  } catch (error) {
    warnings.push({
      path: descriptor.path,
      reason: "memory_file_not_readable",
      detail: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
