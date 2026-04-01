import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  buildSkillsCatalogPrompt,
  loadSkillCatalog,
  resolveDefaultSkillRoots,
} from "@/src/agent/skills.js";

describe("agent skills catalog", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) =>
        rm(dir, {
          recursive: true,
          force: true,
        }),
      ),
    );
  });

  test("loads root, child-directory, and nested skills roots and includes note paths only when present", async () => {
    const baseDir = await createTempDir();
    const rootSkillDir = path.join(baseDir, "root-skill");
    const childRootDir = path.join(baseDir, "child-root");
    const nestedRootDir = path.join(baseDir, "nested-root");

    await mkdir(rootSkillDir, { recursive: true });
    await mkdir(path.join(childRootDir, "lint"), { recursive: true });
    await mkdir(path.join(nestedRootDir, "skills", "deploy"), { recursive: true });

    await writeSkill(rootSkillDir, {
      name: "single-root",
      description: "Use when one skill root is itself the skill directory.",
      note: "Project-specific note for the single-root skill.",
    });
    await writeSkill(path.join(childRootDir, "lint"), {
      name: "lint",
      description: "Use when a repo task needs lint guidance.",
    });
    await writeSkill(path.join(nestedRootDir, "skills", "deploy"), {
      name: "deploy",
      description: "Use when a repo-style nested skills root is present.",
    });

    const snapshot = loadSkillCatalog({
      roots: [
        { source: "global", rootDir: rootSkillDir },
        { source: "workspace", rootDir: childRootDir },
        { source: "repo_agents", rootDir: nestedRootDir },
      ],
    });

    expect(snapshot.warnings).toEqual([]);
    expect(snapshot.entries.map((entry) => entry.name)).toEqual(["deploy", "lint", "single-root"]);

    const singleRootEntry = snapshot.entries.find((entry) => entry.name === "single-root");
    expect(singleRootEntry?.noteFilePath).toMatch(/root-skill[\\/]skill-note\.md$/);

    const lintEntry = snapshot.entries.find((entry) => entry.name === "lint");
    expect(lintEntry?.noteFilePath).toBeUndefined();

    const prompt = buildSkillsCatalogPrompt(snapshot.entries);
    expect(prompt).toContain("<available_skills>");
    expect(prompt).toContain("<name>single-root</name>");
    expect(prompt).toMatch(/<note>.*root-skill[\\/]skill-note\.md<\/note>/);
  });

  test("uses later roots as overrides and lets built-in skills win on name conflicts", async () => {
    const baseDir = await createTempDir();
    const globalRoot = path.join(baseDir, "global");
    const workspaceRoot = path.join(baseDir, "workspace");
    const repoAgentsRoot = path.join(baseDir, "repo-agents");
    const builtInRoot = path.join(baseDir, "builtin");

    await mkdir(path.join(globalRoot, "review"), { recursive: true });
    await mkdir(path.join(workspaceRoot, "review"), { recursive: true });
    await mkdir(path.join(repoAgentsRoot, "review"), { recursive: true });
    await mkdir(path.join(builtInRoot, "review"), { recursive: true });

    await writeSkill(path.join(globalRoot, "review"), {
      name: "review",
      description: "global description",
    });
    await writeSkill(path.join(workspaceRoot, "review"), {
      name: "review",
      description: "workspace description",
    });
    await writeSkill(path.join(repoAgentsRoot, "review"), {
      name: "review",
      description: "repo-agents description",
    });
    await writeSkill(path.join(builtInRoot, "review"), {
      name: "review",
      description: "builtin description",
    });

    const snapshot = loadSkillCatalog({
      roots: [
        { source: "global", rootDir: globalRoot },
        { source: "workspace", rootDir: workspaceRoot },
        { source: "repo_agents", rootDir: repoAgentsRoot },
        { source: "builtin", rootDir: builtInRoot },
      ],
    });

    expect(snapshot.warnings).toEqual([]);
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.entries[0]?.description).toBe("builtin description");
    expect(snapshot.entries[0]?.source).toBe("builtin");
  });

  test("warns and skips malformed skills", async () => {
    const baseDir = await createTempDir();
    const malformedRoot = path.join(baseDir, "malformed");

    await mkdir(path.join(malformedRoot, "unclosed"), { recursive: true });
    await mkdir(path.join(malformedRoot, "missing-description"), { recursive: true });
    await mkdir(path.join(malformedRoot, "no-frontmatter"), { recursive: true });

    await writeFile(
      path.join(malformedRoot, "unclosed", "SKILL.md"),
      ["---", "name: broken", "description: broken frontmatter"].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(malformedRoot, "missing-description", "SKILL.md"),
      ["---", "name: missing-description", "---", "", "Body"].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(malformedRoot, "no-frontmatter", "SKILL.md"),
      ["# not frontmatter", "", "Body"].join("\n"),
      "utf8",
    );

    const snapshot = loadSkillCatalog({
      roots: [{ source: "workspace", rootDir: malformedRoot }],
    });

    expect(snapshot.entries).toEqual([]);
    expect(snapshot.warnings.map((warning) => warning.reason).sort()).toEqual([
      "frontmatter_missing",
      "frontmatter_unclosed",
      "missing_required_fields",
    ]);
  });

  test("resolves repo-local roots from the nearest git root within three parent levels", async () => {
    const baseDir = await createTempDir();
    const repoRoot = path.join(baseDir, "repo");
    const nestedWorkdir = path.join(repoRoot, "packages", "web", "src");

    await mkdir(path.join(repoRoot, ".git"), { recursive: true });
    await mkdir(nestedWorkdir, { recursive: true });

    const roots = resolveDefaultSkillRoots(nestedWorkdir);

    expect(roots.map((root) => [root.source, root.rootDir])).toEqual([
      ["global", expect.stringMatching(/\.pokeclaw[\\/]skills$/)],
      ["workspace", expect.stringMatching(/\.pokeclaw[\\/]workspace[\\/]skills$/)],
      ["repo_agents", path.join(repoRoot, ".agents", "skills")],
      ["repo_claude", path.join(repoRoot, ".claude", "skills")],
      ["builtin", expect.any(String)],
    ]);
  });

  test("does not add repo-local roots when no git root is found within the search window", async () => {
    const baseDir = await createTempDir();
    const deepWorkdir = path.join(baseDir, "a", "b", "c", "d", "e");

    await mkdir(deepWorkdir, { recursive: true });
    await mkdir(path.join(baseDir, ".git"), { recursive: true });

    const roots = resolveDefaultSkillRoots(deepWorkdir);

    expect(roots.map((root) => root.source)).toEqual(["global", "workspace", "builtin"]);
  });

  async function createTempDir(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "pokeclaw-skills-"));
    tempDirs.push(dir);
    return dir;
  }
});

async function writeSkill(
  skillDir: string,
  input: {
    name: string;
    description: string;
    note?: string;
  },
): Promise<void> {
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    [
      "---",
      `name: ${input.name}`,
      `description: ${input.description}`,
      "---",
      "",
      `# ${input.name}`,
      "",
      "Body",
    ].join("\n"),
    "utf8",
  );

  if (input.note != null) {
    await writeFile(path.join(skillDir, "skill-note.md"), input.note, "utf8");
  }
}
