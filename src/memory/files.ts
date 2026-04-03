import fs from "node:fs";
import path from "node:path";

import { buildSubagentWorkspaceDir, POKECLAW_WORKSPACE_DIR } from "@/src/shared/paths.js";

export type AgentMemoryLayer = "soul" | "shared" | "private";

export interface AgentMemoryFileDescriptor {
  layer: AgentMemoryLayer;
  path: string;
  purpose: string;
}

export const DEFAULT_SOUL_FILENAME = "SOUL.md";
export const DEFAULT_MEMORY_FILENAME = "MEMORY.md";
export const DEFAULT_BOOTSTRAP_FILENAME = "BOOTSTRAP.md";

const DEFAULT_SOUL_SCAFFOLD = [
  "# Identity",
  "- Assistant name:",
  "- Default tone:",
  "- Boundaries:",
  "",
  "# User Profile",
  "- Preferred name:",
  "- Role or occupation:",
  "- Timezone:",
  "- Location:",
  "- Stable background facts:",
  "",
].join("\n");

const DEFAULT_SHARED_MEMORY_SCAFFOLD = [
  "# Preferences",
  "",
  "# Durable Facts",
  "",
  "# Projects",
  "",
  "# Working Conventions",
  "",
  "# Repeat-Use Lessons",
  "",
].join("\n");

const DEFAULT_PRIVATE_MEMORY_SCAFFOLD = [
  "# Scope",
  "",
  "# Durable Local Facts",
  "",
  "# Repeat-Use Lessons",
  "",
].join("\n");

const DEFAULT_BOOTSTRAP_SCAFFOLD = [
  "# BOOTSTRAP.md",
  "",
  "This is the first-run bootstrap for the main assistant.",
  "",
  "Your first priority is to create a usable SOUL.md.",
  "",
  "Start by naturally confirming two names:",
  "- what you should call the user",
  "- what the user wants to call you",
  "",
  "Talk naturally and warmly. Do not interrogate the user or force them through a form.",
  "",
  "Try to learn enough durable information to establish:",
  "- the preferred names on both sides",
  "- their role or background",
  "- their timezone or location if relevant",
  "- the assistant's desired tone, boundaries, and relationship style",
  "",
  "Not every question must be answered. If the user declines to share something, that is fine.",
  "",
  "Update SOUL.md first. Use MEMORY.md only for clear durable preferences or facts that belong in shared memory.",
  "",
  "When SOUL.md is good enough to guide future sessions, delete BOOTSTRAP.md with bash rm and continue normally.",
  "",
].join("\n");

export function buildWorkspaceSoulPath(workspaceDir: string): string {
  return path.join(workspaceDir, DEFAULT_SOUL_FILENAME);
}

export function buildWorkspaceSharedMemoryPath(workspaceDir: string): string {
  return path.join(workspaceDir, DEFAULT_MEMORY_FILENAME);
}

export function buildWorkspaceBootstrapPath(workspaceDir: string): string {
  return path.join(workspaceDir, DEFAULT_BOOTSTRAP_FILENAME);
}

export function buildSubagentMemoryPath(agentId: string): string {
  return buildPrivateWorkspaceMemoryPath(buildSubagentWorkspaceDir(agentId));
}

export function buildPrivateWorkspaceMemoryPath(privateWorkspaceDir: string): string {
  return path.join(privateWorkspaceDir, DEFAULT_MEMORY_FILENAME);
}

export function ensureAgentMemoryFiles(input: {
  agentKind?: string | null;
  workspaceDir?: string | null;
  privateWorkspaceDir?: string | null;
}): AgentMemoryFileDescriptor[] {
  const workspaceDir = path.resolve(input.workspaceDir ?? POKECLAW_WORKSPACE_DIR);
  const soulPath = buildWorkspaceSoulPath(workspaceDir);
  const soulMissing = !fs.existsSync(soulPath);
  const descriptors = resolveAgentMemoryFileDescriptors(input);
  for (const descriptor of descriptors) {
    ensureMemoryFileScaffold(descriptor);
  }
  if (input.agentKind === "main" && soulMissing) {
    ensureBootstrapScaffold(workspaceDir);
  }
  return descriptors;
}

export function resolveAgentMemoryFileDescriptors(input: {
  agentKind?: string | null;
  workspaceDir?: string | null;
  privateWorkspaceDir?: string | null;
}): AgentMemoryFileDescriptor[] {
  if (input.agentKind !== "main" && input.agentKind !== "sub") {
    return [];
  }

  const workspaceDir = path.resolve(input.workspaceDir ?? POKECLAW_WORKSPACE_DIR);
  const descriptors: AgentMemoryFileDescriptor[] = [
    {
      layer: "soul",
      path: buildWorkspaceSoulPath(workspaceDir),
      purpose: "Identity, tone, boundaries, and stable user profile.",
    },
    {
      layer: "shared",
      path: buildWorkspaceSharedMemoryPath(workspaceDir),
      purpose: "Long-lived shared memory and the main agent's durable memory.",
    },
  ];

  if (input.agentKind === "sub" && input.privateWorkspaceDir != null) {
    descriptors.push({
      layer: "private",
      path: buildPrivateWorkspaceMemoryPath(input.privateWorkspaceDir),
      purpose: "This subagent's private durable memory for local constraints and lessons.",
    });
  }

  return dedupeMemoryDescriptors(descriptors);
}

function dedupeMemoryDescriptors(
  descriptors: AgentMemoryFileDescriptor[],
): AgentMemoryFileDescriptor[] {
  const seen = new Set<string>();
  const deduped: AgentMemoryFileDescriptor[] = [];

  for (const descriptor of descriptors) {
    const normalizedPath = path.resolve(descriptor.path);
    if (seen.has(normalizedPath)) {
      continue;
    }
    seen.add(normalizedPath);
    deduped.push({
      layer: descriptor.layer,
      path: normalizedPath,
      purpose: descriptor.purpose,
    });
  }

  return deduped;
}

function ensureMemoryFileScaffold(descriptor: AgentMemoryFileDescriptor): void {
  fs.mkdirSync(path.dirname(descriptor.path), { recursive: true });

  try {
    fs.writeFileSync(descriptor.path, getDefaultMemoryScaffold(descriptor.layer), {
      encoding: "utf-8",
      flag: "wx",
    });
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "EEXIST") {
      throw error;
    }
  }
}

function getDefaultMemoryScaffold(layer: AgentMemoryLayer): string {
  switch (layer) {
    case "soul":
      return DEFAULT_SOUL_SCAFFOLD;
    case "shared":
      return DEFAULT_SHARED_MEMORY_SCAFFOLD;
    case "private":
      return DEFAULT_PRIVATE_MEMORY_SCAFFOLD;
  }
}

function ensureBootstrapScaffold(workspaceDir: string): void {
  const bootstrapPath = buildWorkspaceBootstrapPath(workspaceDir);
  fs.mkdirSync(path.dirname(bootstrapPath), { recursive: true });

  try {
    fs.writeFileSync(bootstrapPath, DEFAULT_BOOTSTRAP_SCAFFOLD, {
      encoding: "utf-8",
      flag: "wx",
    });
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "EEXIST") {
      throw error;
    }
  }
}
