import {
  buildApprovalAgentIdentitySection,
  buildApprovalAgentOperatingModelSection,
  buildApprovalReviewSection,
  buildBashFullAccessSection,
  buildFutureRuntimeSections,
  buildMainAgentIdentitySection,
  buildMainAgentOperatingModelSection,
  buildMemorySection,
  buildPermissionsSection,
  buildProjectContextSection,
  buildSafetySection,
  buildSkillsSection,
  buildSubagentIdentitySection,
  buildSubagentOperatingModelSection,
  buildSubagentProfileSection,
  buildTaskAgentIdentitySection,
  buildTaskAgentOperatingModelSection,
  buildToolUsageSection,
  buildWorkspaceRuntimeSection,
} from "@/src/agent/system-prompt-sections.js";

function joinSections(sections: string[]): string {
  return sections.filter((section) => section.trim().length > 0).join("\n\n");
}

interface BuildAgentSystemPromptInput {
  sessionPurpose?: string;
  agentKind?: string | null;
  displayName?: string | null;
  description?: string | null;
  workdir?: string | null;
}

function buildTaskAgentSystemPrompt(): string {
  return joinSections([
    buildTaskAgentIdentitySection(),
    buildTaskAgentOperatingModelSection(),
    buildToolUsageSection(),
    buildPermissionsSection(),
    buildBashFullAccessSection(),
    buildSafetySection(),
    buildWorkspaceRuntimeSection(),
    buildProjectContextSection(),
    buildMemorySection(),
    buildSkillsSection(),
    buildFutureRuntimeSections(),
  ]);
}

function buildMainAgentSystemPrompt(): string {
  return joinSections([
    buildMainAgentIdentitySection(),
    buildMainAgentOperatingModelSection(),
    buildToolUsageSection(),
    buildPermissionsSection(),
    buildBashFullAccessSection(),
    buildSafetySection(),
    buildWorkspaceRuntimeSection(),
    buildProjectContextSection(),
    buildMemorySection(),
    buildSkillsSection(),
    buildFutureRuntimeSections(),
  ]);
}

function buildSubagentSystemPrompt(input: BuildAgentSystemPromptInput): string {
  return joinSections([
    buildSubagentIdentitySection(),
    buildSubagentProfileSection({
      ...(input.displayName === undefined ? {} : { title: input.displayName }),
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.workdir === undefined ? {} : { workdir: input.workdir }),
    }),
    buildSubagentOperatingModelSection(),
    buildToolUsageSection(),
    buildPermissionsSection(),
    buildBashFullAccessSection(),
    buildSafetySection(),
    buildWorkspaceRuntimeSection(),
    buildProjectContextSection(),
    buildMemorySection(),
    buildSkillsSection(),
    buildFutureRuntimeSections(),
  ]);
}

function buildApprovalAgentSystemPrompt(): string {
  return joinSections([
    buildApprovalAgentIdentitySection(),
    buildApprovalAgentOperatingModelSection(),
    buildToolUsageSection(),
    buildApprovalReviewSection(),
    buildSafetySection(),
    buildWorkspaceRuntimeSection(),
    buildProjectContextSection(),
    buildMemorySection(),
    buildSkillsSection(),
    buildFutureRuntimeSections(),
  ]);
}

// Keep the prompt assembled from purpose-specific builders so each runtime role
// can evolve into a distinct agent setup instead of accumulating branchy patch
// logic inside one shared prompt body.
export function buildAgentSystemPrompt(input: BuildAgentSystemPromptInput = {}): string {
  if (input.sessionPurpose === "approval") {
    return buildApprovalAgentSystemPrompt();
  }

  if (input.sessionPurpose === "task") {
    return buildTaskAgentSystemPrompt();
  }

  if (input.agentKind === "main") {
    return buildMainAgentSystemPrompt();
  }

  if (input.agentKind === "sub") {
    return buildSubagentSystemPrompt(input);
  }

  return buildTaskAgentSystemPrompt();
}

export const AGENT_SYSTEM_PROMPT = buildAgentSystemPrompt({
  sessionPurpose: "chat",
  agentKind: "main",
});
