import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_NAME = "a2ui-author";

async function main(): Promise<void> {
  const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const sourceDir = resolveA2uiAuthorSkillSource(repoRoot);
  const targetDir = path.join(repoRoot, "skills", SKILL_NAME);

  assertSkillSource(sourceDir);
  assertSafeBuiltinSkillTarget(repoRoot, targetDir);

  await mkdir(path.dirname(targetDir), { recursive: true });
  await rm(targetDir, { recursive: true, force: true });
  await cp(sourceDir, targetDir, { recursive: true });

  console.log(`Synced ${SKILL_NAME} builtin skill`);
  console.log(`source: ${sourceDir}`);
  console.log(`target: ${targetDir}`);
}

function resolveA2uiAuthorSkillSource(repoRoot: string): string {
  const override = process.env.A2UI_AUTHOR_SKILL_SOURCE;
  if (override != null && override.trim().length > 0) {
    return path.resolve(override);
  }

  return path.join(repoRoot, "node_modules", "lark-a2ui-renderer", "skills");
}

function assertSkillSource(sourceDir: string): void {
  const skillFilePath = path.join(sourceDir, "SKILL.md");
  if (!existsSync(skillFilePath)) {
    throw new Error(`A2UI author skill source is missing SKILL.md: ${sourceDir}`);
  }

  const skillBody = readFileSync(skillFilePath, "utf8");
  if (!/^name:\s*a2ui-author\s*$/mu.test(skillBody)) {
    throw new Error(`A2UI author skill source must be named ${SKILL_NAME}: ${skillFilePath}`);
  }
}

function assertSafeBuiltinSkillTarget(repoRoot: string, targetDir: string): void {
  const builtinSkillsRoot = path.join(repoRoot, "skills");
  const relative = path.relative(builtinSkillsRoot, targetDir);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to sync outside builtin skills root: ${targetDir}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
