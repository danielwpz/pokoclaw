import path from "node:path";

import { buildSubagentWorkspaceDir, POKOCLAW_WORKSPACE_DIR } from "@/src/shared/paths.js";
import type { Agent } from "@/src/storage/schema/types.js";

export function resolveAgentWorkspaceDir(
  agent: Pick<Agent, "id" | "kind">,
  workspaceDir = POKOCLAW_WORKSPACE_DIR,
): string {
  const normalizedWorkspaceDir = path.resolve(workspaceDir);
  if (agent.kind !== "sub") {
    return normalizedWorkspaceDir;
  }

  return buildSubagentWorkspaceDir(agent.id, path.join(normalizedWorkspaceDir, "subagents"));
}
