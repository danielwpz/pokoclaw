import fs from "node:fs";
import path from "node:path";
import { createSubsystemLogger } from "@/src/shared/logger.js";
import {
  POKECLAW_BUILTIN_SKILLS_DIR,
  POKECLAW_SKILLS_DIR,
  POKECLAW_WORKSPACE_DIR,
} from "@/src/shared/paths.js";
import { resolveRepoLocalSkillDirs } from "@/src/shared/repo-skill-roots.js";

const logger = createSubsystemLogger("agent-skills");

const SKILL_FILE_NAME = "SKILL.md";
const SKILL_NOTE_FILE_NAME = "skill-note.md";
const MAX_FRONTMATTER_BYTES = 8 * 1024;
const MAX_FRONTMATTER_LINES = 64;
const MAX_NESTED_ROOT_SCAN = 100;

export type AgentSkillSource = "global" | "workspace" | "repo_agents" | "repo_claude" | "builtin";

export interface AgentSkillRoot {
  source: AgentSkillSource;
  rootDir: string;
}

export interface AgentSkillCatalogWarning {
  source: AgentSkillRoot["source"];
  rootDir: string;
  reason:
    | "frontmatter_missing"
    | "frontmatter_unclosed"
    | "frontmatter_parse_failed"
    | "missing_required_fields"
    | "skill_file_not_found"
    | "skill_file_not_readable"
    | "skill_path_escape"
    | "skill_note_not_readable";
  skillPath?: string;
  detail?: string;
}

export interface AgentSkillCatalogEntry {
  name: string;
  description: string;
  skillKey: string;
  source: AgentSkillRoot["source"];
  rootDir: string;
  skillDir: string;
  skillFilePath: string;
  noteFilePath?: string;
}

export interface AgentSkillCatalogSnapshot {
  entries: AgentSkillCatalogEntry[];
  prompt: string;
  warnings: AgentSkillCatalogWarning[];
}

export interface AgentSkillsResolver {
  resolveForRun(input: { workdir?: string | null }): AgentSkillCatalogSnapshot;
}

interface FilterSkillCatalogSnapshotOptions {
  allowedSources: readonly AgentSkillSource[];
}

interface LoadSkillCatalogOptions {
  roots?: AgentSkillRoot[];
  workdir?: string | null;
}

interface ParsedSkillFrontmatter {
  name: string;
  description: string;
  skillKey?: string;
}

export class FilesystemAgentSkillsResolver implements AgentSkillsResolver {
  resolveForRun(input: { workdir?: string | null }): AgentSkillCatalogSnapshot {
    const snapshot = loadSkillCatalog(
      input.workdir === undefined ? undefined : { workdir: input.workdir },
    );

    for (const warning of snapshot.warnings) {
      logger.warn("skill scan warning", {
        source: warning.source,
        rootDir: warning.rootDir,
        reason: warning.reason,
        skillPath: warning.skillPath,
        detail: warning.detail,
      });
    }

    return snapshot;
  }
}

export function loadSkillCatalog(options: LoadSkillCatalogOptions = {}): AgentSkillCatalogSnapshot {
  const roots = dedupeSkillRoots(options.roots ?? resolveDefaultSkillRoots(options.workdir));
  const warnings: AgentSkillCatalogWarning[] = [];
  const merged = new Map<string, AgentSkillCatalogEntry>();

  for (const root of roots) {
    for (const entry of loadSkillsFromRoot(root, warnings)) {
      merged.set(entry.name, entry);
    }
  }

  const entries = Array.from(merged.values()).sort((left, right) =>
    left.name.localeCompare(right.name),
  );

  return {
    entries,
    prompt: buildSkillsCatalogPrompt(entries),
    warnings,
  };
}

export function buildSkillsCatalogPrompt(entries: AgentSkillCatalogEntry[]): string {
  if (entries.length === 0) {
    return "";
  }

  const lines = [
    "<skills_catalog>",
    "The block below is a discovery catalog only, not the full instruction body of any skill.",
    "Skill bodies live on disk at the listed paths. A skill becomes actionable only after you read its SKILL.md.",
    "<available_skills>",
  ];
  for (const entry of entries) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(entry.name)}</name>`);
    lines.push(`    <description>${escapeXml(entry.description)}</description>`);
    lines.push(`    <location>${escapeXml(entry.skillFilePath)}</location>`);
    if (entry.noteFilePath != null) {
      lines.push(`    <note>${escapeXml(entry.noteFilePath)}</note>`);
    }
    lines.push("  </skill>");
  }
  lines.push("</available_skills>");
  lines.push("</skills_catalog>");
  return lines.join("\n");
}

export function filterSkillCatalogSnapshot(
  snapshot: AgentSkillCatalogSnapshot,
  options: FilterSkillCatalogSnapshotOptions,
): AgentSkillCatalogSnapshot {
  const allowedSources = new Set(options.allowedSources);
  const entries = snapshot.entries.filter((entry) => allowedSources.has(entry.source));

  return {
    entries,
    prompt: buildSkillsCatalogPrompt(entries),
    warnings: snapshot.warnings,
  };
}

export function filterReadableSkillCatalogSnapshot(
  snapshot: AgentSkillCatalogSnapshot,
  input: {
    canReadPath: (absolutePath: string) => boolean;
  },
): AgentSkillCatalogSnapshot {
  const entries = snapshot.entries.flatMap((entry): AgentSkillCatalogEntry[] => {
    if (!input.canReadPath(entry.skillFilePath)) {
      return [];
    }

    const readableEntry: AgentSkillCatalogEntry = {
      name: entry.name,
      description: entry.description,
      skillKey: entry.skillKey,
      source: entry.source,
      rootDir: entry.rootDir,
      skillDir: entry.skillDir,
      skillFilePath: entry.skillFilePath,
    };
    if (entry.noteFilePath != null && input.canReadPath(entry.noteFilePath)) {
      readableEntry.noteFilePath = entry.noteFilePath;
    }

    return [readableEntry];
  });

  return {
    entries,
    prompt: buildSkillsCatalogPrompt(entries),
    warnings: snapshot.warnings,
  };
}

export function resolveDefaultSkillRoots(workdir?: string | null): AgentSkillRoot[] {
  const roots: AgentSkillRoot[] = [
    {
      source: "global",
      rootDir: POKECLAW_SKILLS_DIR,
    },
    {
      source: "workspace",
      rootDir: path.join(POKECLAW_WORKSPACE_DIR, "skills"),
    },
  ];

  roots.push(...resolveRepoSkillRoots(workdir));

  roots.push({
    source: "builtin",
    rootDir: resolveBundledSkillsDir(),
  });

  return roots;
}

export function resolveBundledSkillsDir(): string {
  return POKECLAW_BUILTIN_SKILLS_DIR;
}

function resolveRepoSkillRoots(workdir?: string | null): AgentSkillRoot[] {
  const repoLocalSkillDirs = resolveRepoLocalSkillDirs(workdir);
  if (repoLocalSkillDirs == null) {
    return [];
  }

  return [
    {
      source: "repo_agents",
      rootDir: repoLocalSkillDirs.agentsSkillsDir,
    },
    {
      source: "repo_claude",
      rootDir: repoLocalSkillDirs.claudeSkillsDir,
    },
  ];
}

function dedupeSkillRoots(roots: AgentSkillRoot[]): AgentSkillRoot[] {
  const seen = new Set<string>();
  const deduped: AgentSkillRoot[] = [];

  for (const root of roots) {
    const normalized = path.resolve(root.rootDir);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    deduped.push({
      source: root.source,
      rootDir: normalized,
    });
  }

  return deduped;
}

function loadSkillsFromRoot(
  root: AgentSkillRoot,
  warnings: AgentSkillCatalogWarning[],
): AgentSkillCatalogEntry[] {
  if (!isExistingDirectory(root.rootDir)) {
    return [];
  }

  const rootRealPath = tryRealpath(root.rootDir) ?? root.rootDir;
  const baseRoot = resolveNestedSkillsRoot(root.rootDir);
  const baseRootRealPath = resolveContainedRealPath({
    source: root.source,
    rootDir: root.rootDir,
    rootRealPath,
    candidatePath: baseRoot,
    warnings,
  });
  if (baseRootRealPath == null) {
    return [];
  }

  const skillDirs = discoverSkillDirectories(baseRootRealPath);
  const entries: AgentSkillCatalogEntry[] = [];

  for (const skillDir of skillDirs) {
    const skillFilePath = path.join(skillDir, SKILL_FILE_NAME);
    const skillFileRealPath = resolveContainedRealPath({
      source: root.source,
      rootDir: root.rootDir,
      rootRealPath: baseRootRealPath,
      candidatePath: skillFilePath,
      warnings,
    });
    if (skillFileRealPath == null) {
      continue;
    }

    const loaded = loadSkillEntry({
      root,
      rootRealPath: baseRootRealPath,
      skillDir,
      skillFilePath: skillFileRealPath,
      warnings,
    });
    if (loaded != null) {
      entries.push(loaded);
    }
  }

  return entries;
}

function discoverSkillDirectories(baseRoot: string): string[] {
  const rootSkillPath = path.join(baseRoot, SKILL_FILE_NAME);
  if (isExistingFile(rootSkillPath)) {
    return [baseRoot];
  }

  const entries = listChildDirectories(baseRoot);
  const skillDirs: string[] = [];
  for (const entry of entries) {
    const skillDir = path.join(baseRoot, entry);
    if (isExistingFile(path.join(skillDir, SKILL_FILE_NAME))) {
      skillDirs.push(skillDir);
    }
  }
  return skillDirs;
}

function resolveNestedSkillsRoot(dir: string): string {
  const nestedRoot = path.join(dir, "skills");
  if (!isExistingDirectory(nestedRoot)) {
    return dir;
  }

  const entries = listChildDirectories(nestedRoot).slice(0, MAX_NESTED_ROOT_SCAN);
  for (const entry of entries) {
    if (isExistingFile(path.join(nestedRoot, entry, SKILL_FILE_NAME))) {
      return nestedRoot;
    }
  }

  return dir;
}

function loadSkillEntry(input: {
  root: AgentSkillRoot;
  rootRealPath: string;
  skillDir: string;
  skillFilePath: string;
  warnings: AgentSkillCatalogWarning[];
}): AgentSkillCatalogEntry | null {
  const frontmatter = readAndParseSkillFrontmatter(input.skillFilePath, {
    source: input.root.source,
    rootDir: input.root.rootDir,
    warnings: input.warnings,
  });
  if (frontmatter == null) {
    return null;
  }

  const noteFilePath = resolveNoteFilePath({
    source: input.root.source,
    rootDir: input.root.rootDir,
    rootRealPath: input.rootRealPath,
    skillDir: input.skillDir,
    warnings: input.warnings,
  });

  return {
    name: frontmatter.name,
    description: frontmatter.description,
    skillKey:
      frontmatter.skillKey ??
      buildDerivedSkillKey(input.root.source, input.root.rootDir, input.skillFilePath),
    source: input.root.source,
    rootDir: input.root.rootDir,
    skillDir: input.skillDir,
    skillFilePath: input.skillFilePath,
    ...(noteFilePath == null ? {} : { noteFilePath }),
  };
}

function resolveNoteFilePath(input: {
  source: AgentSkillRoot["source"];
  rootDir: string;
  rootRealPath: string;
  skillDir: string;
  warnings: AgentSkillCatalogWarning[];
}): string | undefined {
  const notePath = path.join(input.skillDir, SKILL_NOTE_FILE_NAME);
  if (!fs.existsSync(notePath)) {
    return undefined;
  }

  const noteRealPath = resolveContainedRealPath({
    source: input.source,
    rootDir: input.rootDir,
    rootRealPath: input.rootRealPath,
    candidatePath: notePath,
    warnings: input.warnings,
  });
  if (noteRealPath == null) {
    return undefined;
  }

  try {
    if (!fs.statSync(noteRealPath).isFile()) {
      input.warnings.push({
        source: input.source,
        rootDir: input.rootDir,
        reason: "skill_note_not_readable",
        skillPath: noteRealPath,
        detail: "skill-note.md exists but is not a regular file",
      });
      return undefined;
    }
  } catch (error) {
    input.warnings.push({
      source: input.source,
      rootDir: input.rootDir,
      reason: "skill_note_not_readable",
      skillPath: noteRealPath,
      detail: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }

  return noteRealPath;
}

function readAndParseSkillFrontmatter(
  skillFilePath: string,
  input: {
    source: AgentSkillRoot["source"];
    rootDir: string;
    warnings: AgentSkillCatalogWarning[];
  },
): ParsedSkillFrontmatter | null {
  const frontmatterText = readSkillFrontmatterBlock(skillFilePath, input);
  if (frontmatterText == null) {
    return null;
  }

  try {
    const parsed = parseFrontmatterFields(frontmatterText);
    const name = parsed.name?.trim() ?? "";
    const description = parsed.description?.trim() ?? "";
    if (name.length === 0 || description.length === 0) {
      input.warnings.push({
        source: input.source,
        rootDir: input.rootDir,
        reason: "missing_required_fields",
        skillPath: skillFilePath,
        detail: "SKILL.md frontmatter must include non-empty name and description",
      });
      return null;
    }

    return {
      name,
      description,
      ...(parsed.skillKey == null && parsed.skill_key == null
        ? {}
        : { skillKey: (parsed.skillKey ?? parsed.skill_key ?? "").trim() }),
    };
  } catch (error) {
    input.warnings.push({
      source: input.source,
      rootDir: input.rootDir,
      reason: "frontmatter_parse_failed",
      skillPath: skillFilePath,
      detail: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function readSkillFrontmatterBlock(
  skillFilePath: string,
  input: {
    source: AgentSkillRoot["source"];
    rootDir: string;
    warnings: AgentSkillCatalogWarning[];
  },
): string | null {
  if (!isExistingFile(skillFilePath)) {
    input.warnings.push({
      source: input.source,
      rootDir: input.rootDir,
      reason: "skill_file_not_found",
      skillPath: skillFilePath,
    });
    return null;
  }

  let fileDescriptor: number | null = null;
  try {
    fileDescriptor = fs.openSync(skillFilePath, "r");
    const buffer = Buffer.allocUnsafe(MAX_FRONTMATTER_BYTES);
    const bytesRead = fs.readSync(fileDescriptor, buffer, 0, MAX_FRONTMATTER_BYTES, 0);
    let head = buffer.toString("utf8", 0, bytesRead);
    const truncatedByBytes = bytesRead === MAX_FRONTMATTER_BYTES;
    if (truncatedByBytes && !head.endsWith("\n") && !head.endsWith("\r")) {
      const lastNewline = Math.max(head.lastIndexOf("\n"), head.lastIndexOf("\r"));
      head = lastNewline >= 0 ? head.slice(0, lastNewline + 1) : "";
    }

    let lines = splitLines(head);
    const truncatedByLines = lines.length > MAX_FRONTMATTER_LINES;
    if (truncatedByLines) {
      lines = lines.slice(0, MAX_FRONTMATTER_LINES);
    }

    if (lines.length === 0) {
      input.warnings.push({
        source: input.source,
        rootDir: input.rootDir,
        reason: "frontmatter_missing",
        skillPath: skillFilePath,
        detail: "SKILL.md is empty or its frontmatter header could not be read",
      });
      return null;
    }

    if (stripBom(lines[0] ?? "") !== "---") {
      input.warnings.push({
        source: input.source,
        rootDir: input.rootDir,
        reason: "frontmatter_missing",
        skillPath: skillFilePath,
        detail: "SKILL.md must start with a YAML frontmatter block",
      });
      return null;
    }

    let closingIndex = -1;
    for (let index = 1; index < lines.length; index += 1) {
      const line = lines[index]?.trim();
      if (line === "---" || line === "...") {
        closingIndex = index;
        break;
      }
    }

    if (closingIndex < 0) {
      input.warnings.push({
        source: input.source,
        rootDir: input.rootDir,
        reason: "frontmatter_unclosed",
        skillPath: skillFilePath,
        detail:
          truncatedByBytes || truncatedByLines
            ? "frontmatter did not close before the scan window limit"
            : "frontmatter did not close before end of file",
      });
      return null;
    }

    return lines.slice(1, closingIndex).join("\n");
  } catch (error) {
    input.warnings.push({
      source: input.source,
      rootDir: input.rootDir,
      reason: "skill_file_not_readable",
      skillPath: skillFilePath,
      detail: error instanceof Error ? error.message : String(error),
    });
    return null;
  } finally {
    if (fileDescriptor != null) {
      fs.closeSync(fileDescriptor);
    }
  }
}

function parseFrontmatterFields(frontmatter: string): Record<string, string> {
  const lines = splitLines(frontmatter);
  const fields: Record<string, string> = {};

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0 || line.trimStart().startsWith("#")) {
      continue;
    }
    if (line.startsWith(" ") || line.startsWith("\t")) {
      continue;
    }

    const match = line.match(/^([A-Za-z0-9_-]+):(?:\s*(.*))?$/);
    if (match == null) {
      continue;
    }

    const key = match[1];
    if (key == null || key.length === 0) {
      continue;
    }
    const rawValue = match[2] ?? "";
    if (rawValue === "|" || rawValue === ">") {
      const blockLines: string[] = [];
      let blockIndex = index + 1;
      while (blockIndex < lines.length) {
        const candidate = lines[blockIndex] ?? "";
        if (
          candidate.length > 0 &&
          !candidate.startsWith(" ") &&
          !candidate.startsWith("\t") &&
          /^[A-Za-z0-9_-]+:/.test(candidate)
        ) {
          break;
        }
        blockLines.push(candidate);
        blockIndex += 1;
      }
      fields[key] = parseBlockScalar(blockLines, rawValue === ">");
      index = blockIndex - 1;
      continue;
    }

    fields[key] = parseScalarValue(rawValue);
  }

  return fields;
}

function parseBlockScalar(lines: string[], folded: boolean): string {
  const nonEmptyIndented = lines.filter((line) => line.trim().length > 0);
  const commonIndent =
    nonEmptyIndented.length === 0
      ? 0
      : nonEmptyIndented.reduce<number>((indent, line) => {
          const currentIndent = line.match(/^[ \t]*/)?.[0].length ?? 0;
          return Math.min(indent, currentIndent);
        }, Number.POSITIVE_INFINITY);

  const normalized = lines.map((line) => line.slice(Math.min(commonIndent, line.length)));
  return folded
    ? normalized
        .map((line) => line.trim())
        .join(" ")
        .replace(/\s+\n\s+/g, "\n\n")
        .trim()
    : normalized.join("\n").trim();
}

function parseScalarValue(rawValue: string): string {
  const trimmed = rawValue.trim();
  if (trimmed.length === 0) {
    return "";
  }

  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed.slice(1, -1);
    }
  }

  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }

  return trimmed.replace(/\s+#.*$/, "").trim();
}

function buildDerivedSkillKey(
  source: AgentSkillRoot["source"],
  rootDir: string,
  skillFilePath: string,
): string {
  const relative = path.relative(rootDir, skillFilePath).replaceAll(path.sep, "/");
  return `${source}:${relative}`;
}

function resolveContainedRealPath(input: {
  source: AgentSkillRoot["source"];
  rootDir: string;
  rootRealPath: string;
  candidatePath: string;
  warnings: AgentSkillCatalogWarning[];
}): string | null {
  const candidateRealPath = tryRealpath(input.candidatePath);
  if (candidateRealPath == null) {
    return null;
  }

  if (isPathInside(input.rootRealPath, candidateRealPath)) {
    return candidateRealPath;
  }

  input.warnings.push({
    source: input.source,
    rootDir: input.rootDir,
    reason: "skill_path_escape",
    skillPath: path.resolve(input.candidatePath),
    detail: `Resolved path escapes the skill root: ${candidateRealPath}`,
  });
  return null;
}

function isPathInside(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function tryRealpath(filePath: string): string | null {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return null;
  }
}

function listChildDirectories(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

function isExistingDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function isExistingFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function stripBom(line: string): string {
  return line.startsWith("\uFEFF") ? line.slice(1) : line;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
