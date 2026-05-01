import fs from "node:fs";
import path from "node:path";

import type { ProjectContextConfig } from "@/src/config/schema.js";
import { createSubsystemLogger } from "@/src/shared/logger.js";
import { findRepoRootFromGit } from "@/src/shared/repo-root.js";

const logger = createSubsystemLogger("project-context");
const WORKDIR_CLAUDE_FILE = "CLAUDE.md";

export type ProjectContextSource = "repo_root" | "workdir";

export interface AgentProjectContextEntry {
  source: ProjectContextSource;
  path: string;
  content: string;
  truncated: boolean;
  originalBytes: number;
  injectedBytes: number;
}

export interface AgentProjectContextWarning {
  path: string;
  reason: "project_context_path_escape" | "project_context_file_not_readable";
  detail?: string;
}

export interface AgentProjectContextSnapshot {
  entries: AgentProjectContextEntry[];
  prompt: string;
  warnings: AgentProjectContextWarning[];
}

export interface AgentProjectContextResolver {
  resolveForRun(input: { workdir?: string | null }): AgentProjectContextSnapshot;
}

export class FilesystemAgentProjectContextResolver implements AgentProjectContextResolver {
  constructor(private readonly config: ProjectContextConfig) {}

  resolveForRun(input: { workdir?: string | null }): AgentProjectContextSnapshot {
    const snapshot = loadAgentProjectContext({
      ...input,
      config: this.config,
    });

    for (const warning of snapshot.warnings) {
      logger.warn("project context warning", {
        path: warning.path,
        reason: warning.reason,
        detail: warning.detail,
      });
    }
    for (const entry of snapshot.entries) {
      if (entry.truncated) {
        logger.warn("project context file truncated", {
          path: entry.path,
          originalBytes: entry.originalBytes,
          injectedBytes: entry.injectedBytes,
        });
      }
    }

    return snapshot;
  }
}

export function loadAgentProjectContext(input: {
  workdir?: string | null;
  config: ProjectContextConfig;
}): AgentProjectContextSnapshot {
  const warnings: AgentProjectContextWarning[] = [];

  if (!input.config.enabled) {
    return emptySnapshot(warnings);
  }

  const workdir = input.workdir?.trim();
  if (!workdir) {
    return emptySnapshot(warnings);
  }

  const repoRoot = findRepoRootFromGit(workdir);
  const normalizedWorkdir = path.resolve(workdir);

  // Fall back to the workdir itself when not inside a git repo. This covers
  // non-code project layouts (Obsidian vaults, document-only folders, etc.)
  // where CLAUDE.md/AGENTS.md live next to the working files but no .git
  // marker exists anywhere up the tree.
  const effectiveRoot = repoRoot ?? normalizedWorkdir;
  const rootSource: ProjectContextSource = repoRoot != null ? "repo_root" : "workdir";

  const effectiveRootRealPath = tryRealpath(effectiveRoot);
  if (effectiveRootRealPath == null) {
    return emptySnapshot(warnings);
  }

  const entries: AgentProjectContextEntry[] = [];
  const seenRealPaths = new Set<string>();

  for (const fileName of input.config.files) {
    const entry = loadProjectContextFile({
      source: rootSource,
      rootRealPath: effectiveRootRealPath,
      baseDir: effectiveRoot,
      fileName,
      maxBytes: input.config.maxBytes,
      warnings,
    });
    if (entry != null && !seenRealPaths.has(entry.path)) {
      seenRealPaths.add(entry.path);
      entries.push(entry);
    }
  }

  const shouldLoadWorkdirClaude =
    repoRoot != null &&
    input.config.files.includes(WORKDIR_CLAUDE_FILE) &&
    normalizedWorkdir !== repoRoot &&
    isPathInside(repoRoot, normalizedWorkdir);
  if (shouldLoadWorkdirClaude) {
    const entry = loadProjectContextFile({
      source: "workdir",
      rootRealPath: effectiveRootRealPath,
      baseDir: normalizedWorkdir,
      fileName: WORKDIR_CLAUDE_FILE,
      maxBytes: input.config.maxBytes,
      warnings,
    });
    if (entry != null && !seenRealPaths.has(entry.path)) {
      seenRealPaths.add(entry.path);
      entries.push(entry);
    }
  }

  return {
    entries,
    prompt: buildProjectContextPrompt(entries),
    warnings,
  };
}

function emptySnapshot(warnings: AgentProjectContextWarning[]): AgentProjectContextSnapshot {
  return {
    entries: [],
    prompt: "",
    warnings,
  };
}

function loadProjectContextFile(input: {
  source: ProjectContextSource;
  rootRealPath: string;
  baseDir: string;
  fileName: string;
  maxBytes: number;
  warnings: AgentProjectContextWarning[];
}): AgentProjectContextEntry | null {
  const candidatePath = path.resolve(input.baseDir, input.fileName);

  try {
    const stat = fs.statSync(candidatePath);
    if (!stat.isFile()) {
      return null;
    }

    const realPath = fs.realpathSync(candidatePath);
    if (!isPathInside(input.rootRealPath, realPath)) {
      input.warnings.push({
        path: candidatePath,
        reason: "project_context_path_escape",
        detail: `Resolved path escapes repo root: ${realPath}`,
      });
      return null;
    }

    const loaded = readProjectContextFileContent({
      filePath: candidatePath,
      fileName: input.fileName,
      originalBytes: stat.size,
      maxBytes: input.maxBytes,
    });

    if (loaded.content.trim().length === 0) {
      return null;
    }

    return {
      source: input.source,
      path: realPath,
      content: loaded.content,
      truncated: loaded.truncated,
      originalBytes: stat.size,
      injectedBytes: Buffer.byteLength(loaded.content, "utf8"),
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }
    input.warnings.push({
      path: candidatePath,
      reason: "project_context_file_not_readable",
      detail: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function readProjectContextFileContent(input: {
  filePath: string;
  fileName: string;
  originalBytes: number;
  maxBytes: number;
}): { content: string; truncated: boolean } {
  if (input.originalBytes <= input.maxBytes) {
    return {
      content: fs.readFileSync(input.filePath, "utf8").trimEnd(),
      truncated: false,
    };
  }

  const headBytes = Math.max(1, Math.floor(input.maxBytes * 0.7));
  const tailBytes = Math.max(1, Math.floor(input.maxBytes * 0.2));
  const headBuffer = Buffer.allocUnsafe(headBytes);
  const tailBuffer = Buffer.allocUnsafe(tailBytes);
  const fd = fs.openSync(input.filePath, "r");
  try {
    const readHeadBytes = fs.readSync(fd, headBuffer, 0, headBytes, 0);
    const readTailBytes = fs.readSync(
      fd,
      tailBuffer,
      0,
      tailBytes,
      Math.max(0, input.originalBytes - tailBytes),
    );
    const head = headBuffer.subarray(0, readHeadBytes).toString("utf8");
    const tail = tailBuffer.subarray(0, readTailBytes).toString("utf8");
    const marker = [
      "",
      `[...truncated at ${input.maxBytes} bytes; read ${input.fileName} for full content...]`,
      `...(truncated ${input.fileName}: kept ${readHeadBytes}+${readTailBytes} bytes of ${input.originalBytes})...`,
      "",
    ].join("\n");
    return {
      content: [head, marker, tail].join("\n").trimEnd(),
      truncated: true,
    };
  } finally {
    fs.closeSync(fd);
  }
}

export function buildProjectContextPrompt(entries: AgentProjectContextEntry[]): string {
  if (entries.length === 0) {
    return "";
  }

  const lines = [
    "<project_context>",
    "The files below are project-specific instructions loaded from the current workdir and git repo. They are injected context, not user-visible output.",
  ];

  for (const entry of entries) {
    lines.push("  <project_context_file>");
    lines.push(`    <source>${entry.source}</source>`);
    lines.push(`    <path>${escapeXml(entry.path)}</path>`);
    if (entry.truncated) {
      lines.push("    <truncated>true</truncated>");
      lines.push(`    <original_bytes>${entry.originalBytes}</original_bytes>`);
      lines.push(`    <injected_bytes>${entry.injectedBytes}</injected_bytes>`);
    }
    lines.push("    <content>");
    for (const line of entry.content.split(/\r?\n/)) {
      lines.push(`      ${escapeXml(line)}`);
    }
    lines.push("    </content>");
    lines.push("  </project_context_file>");
  }

  lines.push("</project_context>");
  return lines.join("\n");
}

function tryRealpath(targetPath: string): string | null {
  try {
    return fs.realpathSync(targetPath);
  } catch {
    return null;
  }
}

function isPathInside(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
