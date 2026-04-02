import path from "node:path";
import { findRepoRootFromGit } from "@/src/shared/repo-root.js";

export interface RepoLocalSkillDirs {
  repoRoot: string;
  agentsSkillsDir: string;
  claudeSkillsDir: string;
}

export function resolveRepoLocalSkillDirs(workdir?: string | null): RepoLocalSkillDirs | null {
  const repoRoot = findRepoRootFromGit(workdir);
  if (repoRoot == null) {
    return null;
  }

  return {
    repoRoot,
    agentsSkillsDir: path.join(repoRoot, ".agents", "skills"),
    claudeSkillsDir: path.join(repoRoot, ".claude", "skills"),
  };
}
