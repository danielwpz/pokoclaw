/**
 * System-prompt assembler for different runtime roles.
 *
 * This module selects and composes prompt sections by session purpose and
 * agent kind (main/sub/task/approval), keeping prompt policy centralized and
 * consistent across loop runs.
 */
import {
  buildApprovalAgentIdentitySection,
  buildApprovalAgentOperatingModelSection,
  buildApprovalReviewSection,
  buildBashFullAccessSection,
  buildFutureRuntimeSections,
  buildMainAgentIdentitySection,
  buildMainAgentOperatingModelSection,
  buildMainAgentScheduledTasksSection,
  buildMainAgentSubagentSection,
  buildMemorySection,
  buildPermissionsSection,
  buildProjectContextSection,
  buildSafetySection,
  buildSkillsSection,
  buildSubagentIdentitySection,
  buildSubagentOperatingModelSection,
  buildSubagentProfileSection,
  buildSubagentScheduledTasksSection,
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
  privateWorkspaceDir?: string | null;
  currentDate?: string | null;
  timezone?: string | null;
  skillsCatalog?: string | null;
}

function buildTaskAgentSystemPrompt(input: BuildAgentSystemPromptInput): string {
  return joinSections([
    buildTaskAgentIdentitySection(),
    buildTaskAgentOperatingModelSection(),
    buildToolUsageSection(),
    buildPermissionsSection(),
    buildBashFullAccessSection(),
    buildSafetySection(),
    buildWorkspaceRuntimeSection({
      ...(input.currentDate === undefined ? {} : { currentDate: input.currentDate }),
      ...(input.timezone === undefined ? {} : { timezone: input.timezone }),
    }),
    buildProjectContextSection(),
    buildMemorySection(),
    buildSkillsSection({
      ...(input.skillsCatalog === undefined ? {} : { skillsCatalog: input.skillsCatalog }),
    }),
    buildFutureRuntimeSections(),
    input.skillsCatalog ?? "",
  ]);
}

function buildMainAgentSystemPrompt(input: BuildAgentSystemPromptInput): string {
  return joinSections([
    buildMainAgentIdentitySection(),
    buildMainAgentOperatingModelSection(),
    buildMainAgentScheduledTasksSection(),
    buildMainAgentSubagentSection(),
    buildToolUsageSection(),
    buildPermissionsSection(),
    buildBashFullAccessSection(),
    buildSafetySection(),
    buildWorkspaceRuntimeSection({
      ...(input.currentDate === undefined ? {} : { currentDate: input.currentDate }),
      ...(input.timezone === undefined ? {} : { timezone: input.timezone }),
    }),
    buildProjectContextSection(),
    buildMemorySection(),
    buildSkillsSection({
      ...(input.skillsCatalog === undefined ? {} : { skillsCatalog: input.skillsCatalog }),
    }),
    buildFutureRuntimeSections(),
    input.skillsCatalog ?? "",
  ]);
}

function buildSubagentSystemPrompt(input: BuildAgentSystemPromptInput): string {
  return joinSections([
    buildSubagentIdentitySection(),
    buildSubagentProfileSection({
      ...(input.displayName === undefined ? {} : { title: input.displayName }),
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.workdir === undefined ? {} : { workdir: input.workdir }),
      ...(input.privateWorkspaceDir === undefined
        ? {}
        : { privateWorkspaceDir: input.privateWorkspaceDir }),
    }),
    buildSubagentOperatingModelSection(),
    buildSubagentScheduledTasksSection(),
    buildToolUsageSection(),
    buildPermissionsSection(),
    buildBashFullAccessSection(),
    buildSafetySection(),
    buildWorkspaceRuntimeSection({
      ...(input.currentDate === undefined ? {} : { currentDate: input.currentDate }),
      ...(input.timezone === undefined ? {} : { timezone: input.timezone }),
    }),
    buildProjectContextSection(),
    buildMemorySection(),
    buildSkillsSection({
      ...(input.skillsCatalog === undefined ? {} : { skillsCatalog: input.skillsCatalog }),
    }),
    buildFutureRuntimeSections(),
    input.skillsCatalog ?? "",
  ]);
}

function buildApprovalAgentSystemPrompt(input: BuildAgentSystemPromptInput): string {
  return joinSections([
    buildApprovalAgentIdentitySection(),
    buildApprovalAgentOperatingModelSection(),
    buildToolUsageSection(),
    buildApprovalReviewSection(),
    buildSafetySection(),
    buildWorkspaceRuntimeSection({
      ...(input.currentDate === undefined ? {} : { currentDate: input.currentDate }),
      ...(input.timezone === undefined ? {} : { timezone: input.timezone }),
    }),
    buildProjectContextSection(),
    buildMemorySection(),
    buildSkillsSection({
      ...(input.skillsCatalog === undefined ? {} : { skillsCatalog: input.skillsCatalog }),
    }),
    buildFutureRuntimeSections(),
    input.skillsCatalog ?? "",
  ]);
}

// Keep the prompt assembled from purpose-specific builders so each runtime role
// can evolve into a distinct agent setup instead of accumulating branchy patch
// logic inside one shared prompt body.
export function buildAgentSystemPrompt(input: BuildAgentSystemPromptInput = {}): string {
  if (input.sessionPurpose === "approval") {
    return buildApprovalAgentSystemPrompt(input);
  }

  if (input.sessionPurpose === "task") {
    return buildTaskAgentSystemPrompt(input);
  }

  if (input.agentKind === "main") {
    return buildMainAgentSystemPrompt(input);
  }

  if (input.agentKind === "sub") {
    return buildSubagentSystemPrompt(input);
  }

  return buildMainAgentSystemPrompt(input);
}

export const AGENT_SYSTEM_PROMPT = buildAgentSystemPrompt({
  sessionPurpose: "chat",
  agentKind: "main",
});
