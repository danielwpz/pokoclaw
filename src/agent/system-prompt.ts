import {
  buildApprovalReviewSection,
  buildBashFullAccessSection,
  buildFutureRuntimeSections,
  buildIdentitySection,
  buildMemorySection,
  buildOperatingModelSection,
  buildPermissionsSection,
  buildProjectContextSection,
  buildSafetySection,
  buildSkillsSection,
  buildToolUsageSection,
  buildWorkspaceRuntimeSection,
} from "@/src/agent/system-prompt-sections.js";

function joinSections(sections: string[]): string {
  return sections.filter((section) => section.trim().length > 0).join("\n\n");
}

interface BuildAgentSystemPromptInput {
  sessionPurpose?: string;
}

// Keep the prompt assembled from small section builders so we can expand it
// incrementally without turning it back into one large opaque string blob.
export function buildAgentSystemPrompt(input: BuildAgentSystemPromptInput = {}): string {
  if (input.sessionPurpose === "approval") {
    return joinSections([
      buildIdentitySection(),
      buildOperatingModelSection(),
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

  return joinSections([
    buildIdentitySection(),
    buildOperatingModelSection(),
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

export const AGENT_SYSTEM_PROMPT = buildAgentSystemPrompt();
