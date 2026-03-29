import { describe, expect, test } from "vitest";
import { AGENT_SYSTEM_PROMPT, buildAgentSystemPrompt } from "@/src/agent/system-prompt.js";
import {
  buildApprovalAgentIdentitySection,
  buildApprovalAgentOperatingModelSection,
  buildApprovalReviewSection,
  buildBashFullAccessSection,
  buildMainAgentIdentitySection,
  buildMainAgentOperatingModelSection,
  buildMainAgentSubagentSection,
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

describe("agent system prompt", () => {
  test("builds the current structured sections and omits future empty sections", () => {
    const prompt = buildAgentSystemPrompt({
      sessionPurpose: "chat",
      agentKind: "main",
    });

    expect(prompt).toContain("You are Pokeclaw Main Agent");
    expect(prompt).toContain("## Operating Model");
    expect(prompt).toContain("## SubAgent Creation");
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
    const prompt = buildAgentSystemPrompt({
      sessionPurpose: "chat",
      agentKind: "main",
    });

    const operatingIndex = prompt.indexOf("## Operating Model");
    const subagentIndex = prompt.indexOf("## SubAgent Creation");
    const toolUsageIndex = prompt.indexOf("## Tool Usage");
    const permissionsIndex = prompt.indexOf("## Permissions");
    const bashIndex = prompt.indexOf("## Bash Full Access");
    const safetyIndex = prompt.indexOf("## Safety");

    expect(operatingIndex).toBeGreaterThanOrEqual(0);
    expect(subagentIndex).toBeGreaterThan(operatingIndex);
    expect(toolUsageIndex).toBeGreaterThan(operatingIndex);
    expect(toolUsageIndex).toBeGreaterThan(subagentIndex);
    expect(permissionsIndex).toBeGreaterThan(toolUsageIndex);
    expect(bashIndex).toBeGreaterThan(permissionsIndex);
    expect(safetyIndex).toBeGreaterThan(bashIndex);
  });

  test("builds a distinct approval-agent identity and operating model", () => {
    const taskPrompt = buildAgentSystemPrompt({ sessionPurpose: "task" });
    const approvalPrompt = buildAgentSystemPrompt({ sessionPurpose: "approval" });

    expect(taskPrompt).toContain("You are Pokeclaw, an agent that completes the user's request");
    expect(approvalPrompt).toContain(
      "You are Pokeclaw Approval Reviewer, a dedicated approval agent.",
    );
    expect(approvalPrompt).toContain(
      "Your job is to review permission requests from other runs, not to continue those tasks.",
    );
    expect(taskPrompt).not.toContain("Pokeclaw Approval Reviewer");
    expect(approvalPrompt).not.toContain(
      "You are Pokeclaw, an agent that completes the user's request",
    );
  });

  test("includes the currently required permission and bash guidance", () => {
    const prompt = buildAgentSystemPrompt({
      sessionPurpose: "chat",
      agentKind: "main",
    });

    expect(prompt).toContain("call request_permissions");
    expect(prompt).toContain("retryToolCallId");
    expect(prompt).toContain("Bash runs in a sandbox by default.");
    expect(prompt).toContain("Do not use request_permissions for bash sandbox failures.");
    expect(prompt).toContain('rerun bash with sandboxMode="full_access"');
    expect(prompt).toContain("short human-readable justification");
    expect(prompt).toContain("prefer a reusable prefix");
    expect(prompt).toContain("git is often the first prefix to consider");
    expect(prompt).toContain("pnpm, npm, pytest, cargo");
    expect(prompt).toContain("Only provide a reusable prefix");
    expect(prompt).toContain("do not use unmanaged backgrounding like &, nohup, setsid, or disown");
    expect(prompt).toContain("Do not bypass approval or permission mechanisms.");
  });

  test("teaches the main agent to stay responsive, delegate proactively, and keep global diagnosis work local", () => {
    const prompt = buildAgentSystemPrompt({
      sessionPurpose: "chat",
      agentKind: "main",
    });

    expect(prompt).toContain("the system's long-lived manager");
    expect(prompt).toContain("single entrypoint for new requests, casual conversation");
    expect(prompt).toContain("You can and should handle casual conversation");
    expect(prompt).toContain("Your unique role is to preserve continuity across the whole system");
    expect(prompt).toContain("It is fine to proactively attempt create_subagent");
    expect(prompt).toContain(
      "if the user declines you should simply continue the conversation normally",
    );
    expect(prompt).toContain(
      "System observation, runtime status checks, approval investigation, and cross-agent diagnosis stay with you.",
    );
    expect(prompt).toContain(
      "Do not create a SubAgent just to inspect what the system or another agent is doing.",
    );
    expect(prompt).toContain(
      "Delegation is about protecting the main conversation and creating the right task boundary",
    );
  });

  test("teaches main-agent subagent creation argument shape and examples", () => {
    const prompt = buildAgentSystemPrompt({
      sessionPurpose: "chat",
      agentKind: "main",
    });

    expect(prompt).toContain("repo-specific code changes");
    expect(prompt).toContain("deep research");
    expect(prompt).toContain("repeated bash/test/edit/debug loops");
    expect(prompt).toContain("recurring user-facing tasks");
    expect(prompt).toContain("Helpful reference signals, not hard rules");
    expect(prompt).toContain("more than about 10 bash calls");
    expect(prompt).toContain("more than about 5 conversation turns");
    expect(prompt).toContain("more than about 1 hour of end-to-end work");
    expect(prompt).toContain("Those signals are only guidance");
    expect(prompt).toContain("casual conversation in the main chat");
    expect(prompt).toContain("Prefer the minimal call shape first");
    expect(prompt).toContain("initialExtraScopes");
    expect(prompt).toContain('{"kind":"fs.read","path":"/abs/path"}');
    expect(prompt).toContain('{"kind":"db.read","database":"system"}');
    expect(prompt).toContain('{"kind":"bash.full_access","prefix":["git","status"]}');
    expect(prompt).toContain('"title":"Pokeclaw Code Review"');
    expect(prompt).toContain('"title":"Daily News Briefing"');
    expect(prompt).toContain(
      "greeting the user and clarifying the desired sources, schedule, and output format",
    );
    expect(prompt).toContain("Do not create a SubAgent for system observation");
    expect(prompt).toContain("If the user's intent is still broad or underspecified");
  });

  test("builds a dedicated approval-session prompt without normal tool escalation guidance", () => {
    const prompt = buildAgentSystemPrompt({ sessionPurpose: "approval" });

    expect(prompt).toContain("## Approval Review");
    expect(prompt).toContain("review_permission_request");
    expect(prompt).toContain("You must finish by calling review_permission_request");
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

  test("builds a dedicated subagent prompt with its persisted profile", () => {
    const prompt = buildAgentSystemPrompt({
      sessionPurpose: "chat",
      agentKind: "sub",
      displayName: "PR Review",
      description: "Review pull requests and summarize concrete findings.",
      workdir: "/Users/daniel/Programs/ai/openclaw/pokeclaw",
      privateWorkspaceDir: "/Users/daniel/.pokeclaw/workspace/subagents/1234abcd",
    });

    expect(prompt).toContain("You are Pokeclaw SubAgent");
    expect(prompt).toContain("## SubAgent Profile");
    expect(prompt).toContain("<title>PR Review</title>");
    expect(prompt).toContain("<description>");
    expect(prompt).toContain("<workdir>/Users/daniel/Programs/ai/openclaw/pokeclaw</workdir>");
    expect(prompt).toContain(
      "<private_workspace_dir>/Users/daniel/.pokeclaw/workspace/subagents/1234abcd</private_workspace_dir>",
    );
    expect(prompt).not.toContain("<initial_task>");
    expect(prompt).toContain("You own this workstream");
    expect(prompt).toContain("You are responsible for moving this workstream forward");
    expect(prompt).toContain("You are not the system-wide coordinator");
    expect(prompt).toContain("Treat the kickoff note as system-generated background");
    expect(prompt).toContain("begin this new conversation by greeting the user");
    expect(prompt).toContain("workdir is your default execution and project root");
    expect(prompt).toContain("private_workspace_dir is your own scratch space");
    expect(prompt).toContain("Those two directories may be the same");
    expect(prompt).toContain(
      "When a tool fails, inspect the failure and choose the next step based on the result instead of guessing.",
    );
    expect(prompt).toContain("Bash runs in a sandbox by default.");
    expect(prompt).toContain("Do not use request_permissions for bash sandbox failures.");
    expect(prompt).toContain('rerun bash with sandboxMode="full_access"');
    expect(prompt).toContain("git is often the first prefix to consider");
  });

  test("current filled section builders remain non-empty", () => {
    expect(buildMainAgentIdentitySection()).not.toBe("");
    expect(buildMainAgentOperatingModelSection()).not.toBe("");
    expect(buildMainAgentSubagentSection()).not.toBe("");
    expect(buildSubagentIdentitySection()).not.toBe("");
    expect(buildSubagentOperatingModelSection()).not.toBe("");
    expect(buildSubagentProfileSection({ title: "PR Review" })).not.toBe("");
    expect(buildTaskAgentIdentitySection()).not.toBe("");
    expect(buildApprovalAgentIdentitySection()).not.toBe("");
    expect(buildTaskAgentOperatingModelSection()).not.toBe("");
    expect(buildApprovalAgentOperatingModelSection()).not.toBe("");
    expect(buildToolUsageSection()).not.toBe("");
    expect(buildPermissionsSection()).not.toBe("");
    expect(buildApprovalReviewSection()).not.toBe("");
    expect(buildBashFullAccessSection()).not.toBe("");
    expect(buildSafetySection()).not.toBe("");
  });

  test("teaches agents that one run may interleave visible replies and tool calls", () => {
    const task = buildTaskAgentOperatingModelSection();
    const main = buildMainAgentOperatingModelSection();
    const sub = buildSubagentOperatingModelSection();

    for (const section of [task, main, sub]) {
      expect(section).toContain(
        "One ongoing run may include multiple visible assistant replies separated by tool calls.",
      );
      expect(section).toContain(
        "If the user asks you to report an intermediate result and then continue",
      );
      expect(section).toContain(
        "That intermediate report may appear in the same assistant turn that also requests the next tool call.",
      );
      expect(section).toContain(
        "Do not invent an extra confirmation boundary unless the user explicitly asks",
      );
    }
  });

  test("teaches main and sub agents how to react to tool failures", () => {
    const main = buildMainAgentOperatingModelSection();
    const sub = buildSubagentOperatingModelSection();

    for (const section of [main, sub]) {
      expect(section).toContain(
        "When a tool fails, inspect the failure and choose the next step based on the result instead of guessing.",
      );
    }
  });

  test("exports the built prompt as a stable constant", () => {
    expect(AGENT_SYSTEM_PROMPT).toBe(
      buildAgentSystemPrompt({
        sessionPurpose: "chat",
        agentKind: "main",
      }),
    );
  });
});
