import { describe, expect, test } from "vitest";
import { AGENT_SYSTEM_PROMPT, buildAgentSystemPrompt } from "@/src/agent/system-prompt.js";
import {
  buildApprovalReviewSection,
  buildBashFullAccessSection,
  buildOperatingModelSection,
  buildPermissionsSection,
  buildProjectContextSection,
  buildSafetySection,
  buildSkillsSection,
  buildToolUsageSection,
  buildWorkspaceRuntimeSection,
} from "@/src/agent/system-prompt-sections.js";

describe("agent system prompt", () => {
  test("builds the current structured sections and omits future empty sections", () => {
    const prompt = buildAgentSystemPrompt();

    expect(prompt).toContain("You are Pokeclaw, an agent that completes the user's request");
    expect(prompt).toContain("## Operating Model");
    expect(prompt).toContain("## Tool Usage");
    expect(prompt).toContain("## Permissions");
    expect(prompt).toContain("## Bash Full Access");
    expect(prompt).toContain("## Safety");

    expect(prompt).not.toContain("## Workspace & Runtime");
    expect(prompt).not.toContain("## Project Context");
    expect(prompt).not.toContain("## Memory");
    expect(prompt).not.toContain("## Skills");
  });

  test("keeps the current section order stable", () => {
    const prompt = buildAgentSystemPrompt();

    const operatingIndex = prompt.indexOf("## Operating Model");
    const toolUsageIndex = prompt.indexOf("## Tool Usage");
    const permissionsIndex = prompt.indexOf("## Permissions");
    const bashIndex = prompt.indexOf("## Bash Full Access");
    const safetyIndex = prompt.indexOf("## Safety");

    expect(operatingIndex).toBeGreaterThanOrEqual(0);
    expect(toolUsageIndex).toBeGreaterThan(operatingIndex);
    expect(permissionsIndex).toBeGreaterThan(toolUsageIndex);
    expect(bashIndex).toBeGreaterThan(permissionsIndex);
    expect(safetyIndex).toBeGreaterThan(bashIndex);
  });

  test("includes the currently required permission and bash guidance", () => {
    const prompt = buildAgentSystemPrompt();

    expect(prompt).toContain("call request_permissions");
    expect(prompt).toContain("retryToolCallId");
    expect(prompt).toContain("Do not use request_permissions for bash sandbox failures.");
    expect(prompt).toContain('rerun bash with sandboxMode="full_access"');
    expect(prompt).toContain("Only provide a reusable prefix");
    expect(prompt).toContain("do not use unmanaged backgrounding like &, nohup, setsid, or disown");
    expect(prompt).toContain("Do not bypass approval or permission mechanisms.");
  });

  test("builds a dedicated approval-session prompt without normal tool escalation guidance", () => {
    const prompt = buildAgentSystemPrompt({ sessionPurpose: "approval" });

    expect(prompt).toContain("## Approval Review");
    expect(prompt).toContain("review_permission_request");
    expect(prompt).not.toContain("## Permissions");
    expect(prompt).not.toContain("## Bash Full Access");
    expect(prompt).not.toContain("call request_permissions");
    expect(prompt).not.toContain('sandboxMode="full_access"');
  });

  test("future section builders stay empty until their features are implemented", () => {
    expect(buildWorkspaceRuntimeSection()).toBe("");
    expect(buildProjectContextSection()).toBe("");
    expect(buildSkillsSection()).toBe("");
  });

  test("current filled section builders remain non-empty", () => {
    expect(buildOperatingModelSection()).not.toBe("");
    expect(buildToolUsageSection()).not.toBe("");
    expect(buildPermissionsSection()).not.toBe("");
    expect(buildApprovalReviewSection()).not.toBe("");
    expect(buildBashFullAccessSection()).not.toBe("");
    expect(buildSafetySection()).not.toBe("");
  });

  test("exports the built prompt as a stable constant", () => {
    expect(AGENT_SYSTEM_PROMPT).toBe(buildAgentSystemPrompt());
  });
});
