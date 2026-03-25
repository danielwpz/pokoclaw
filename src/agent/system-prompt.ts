import {
  buildApprovalAgentIdentitySection,
  buildApprovalAgentOperatingModelSection,
  buildApprovalReviewSection,
  buildBashFullAccessSection,
  buildFutureRuntimeSections,
  buildMemorySection,
  buildPermissionsSection,
  buildProjectContextSection,
  buildSafetySection,
  buildSkillsSection,
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
  return input.sessionPurpose === "approval"
    ? buildApprovalAgentSystemPrompt()
    : buildTaskAgentSystemPrompt();
}

export const AGENT_SYSTEM_PROMPT = buildAgentSystemPrompt();
