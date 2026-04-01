import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { executeSandboxedBashMock, executeUnsandboxedBashMock } = vi.hoisted(() => ({
  executeSandboxedBashMock: vi.fn(),
  executeUnsandboxedBashMock: vi.fn(),
}));

import type { AgentAssistantContentBlock } from "@/src/agent/llm/messages.js";
import { ProviderRegistry } from "@/src/agent/llm/provider-registry.js";
import { AgentLoop, type AgentModelRunner } from "@/src/agent/loop.js";
import { AgentSessionService } from "@/src/agent/session.js";
import { DEFAULT_CONFIG } from "@/src/config/defaults.js";
import type { AppConfig } from "@/src/config/schema.js";
import { SessionRunAbortRegistry } from "@/src/runtime/cancel.js";
import { MessagesRepo } from "@/src/storage/repos/messages.repo.js";
import { SessionsRepo } from "@/src/storage/repos/sessions.repo.js";
import { createBashTool } from "@/src/tools/bash.js";
import { toolRecoverableError } from "@/src/tools/core/errors.js";
import { ToolRegistry } from "@/src/tools/core/registry.js";
import {
  createTestDatabase,
  destroyTestDatabase,
  type TestDatabaseHandle,
} from "@/tests/storage/helpers/test-db.js";

vi.mock("@/src/security/sandbox.js", async () => {
  const actual = await vi.importActual<typeof import("@/src/security/sandbox.js")>(
    "@/src/security/sandbox.js",
  );

  return {
    ...actual,
    executeSandboxedBash: executeSandboxedBashMock,
    executeUnsandboxedBash: executeUnsandboxedBashMock,
  };
});

function createModelConfig(): Pick<AppConfig, "providers" | "models"> {
  return {
    providers: {
      anthropic_main: {
        api: "anthropic-messages",
      },
    },
    models: {
      catalog: [
        {
          id: "anthropic_main/claude-sonnet-4-5",
          provider: "anthropic_main",
          upstreamId: "claude-sonnet-4-5-20250929",
          contextWindow: 200_000,
          maxOutputTokens: 16_384,
          supportsTools: true,
          supportsVision: true,
          reasoning: { enabled: true },
        },
      ],
      scenarios: {
        chat: ["anthropic_main/claude-sonnet-4-5"],
        compaction: ["anthropic_main/claude-sonnet-4-5"],
        subagent: ["anthropic_main/claude-sonnet-4-5"],
        cron: ["anthropic_main/claude-sonnet-4-5"],
      },
    },
  };
}

function seedConversationAndAgentFixture(handle: TestDatabaseHandle): void {
  handle.storage.sqlite.exec(`
    INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
    VALUES ('ci_1', 'lark', 'acct_a', '2026-03-22T00:00:00.000Z', '2026-03-22T00:00:00.000Z');

    INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
    VALUES ('conv_1', 'ci_1', 'chat_1', 'dm', '2026-03-22T00:00:00.000Z', '2026-03-22T00:00:00.000Z');

    INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
    VALUES ('branch_1', 'conv_1', 'dm_main', 'main', '2026-03-22T00:00:00.000Z', '2026-03-22T00:00:00.000Z');

    INSERT INTO agents (id, conversation_id, kind, created_at)
    VALUES ('agent_1', 'conv_1', 'sub', '2026-03-22T00:00:00.000Z');
  `);
}

function makeAssistantResult(params: {
  content: AgentAssistantContentBlock[];
  stopReason?: "stop" | "length" | "toolUse" | "error" | "aborted";
}) {
  return {
    provider: "anthropic_main",
    model: "claude-sonnet-4-5",
    modelApi: "anthropic-messages",
    stopReason: params.stopReason ?? "stop",
    content: params.content,
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
    },
  } as const;
}

async function waitForApprovalRequested(
  events: Array<{ type: string; approvalId?: string }>,
): Promise<string> {
  while (true) {
    const approvalId = events.find((event) => event.type === "approval_requested")?.approvalId;
    if (approvalId != null) {
      return approvalId;
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("agent loop bash approval flow", () => {
  let handle: TestDatabaseHandle | null = null;

  beforeEach(() => {
    executeSandboxedBashMock.mockReset();
    executeUnsandboxedBashMock.mockReset();
  });

  afterEach(async () => {
    if (handle != null) {
      await destroyTestDatabase(handle);
      handle = null;
    }
  });

  test("pauses and resumes the same bash tool call after one-shot full-access approval", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    const messagesRepo = new MessagesRepo(handle.storage.db);
    sessionsRepo.create({
      id: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      ownerAgentId: "agent_1",
      purpose: "chat",
      createdAt: new Date("2026-03-22T00:00:00.000Z"),
    });
    messagesRepo.append({
      id: "msg_user",
      sessionId: "sess_1",
      seq: 1,
      role: "user",
      payloadJson: '{"content":"write the note"}',
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
    });

    let modelTurnCount = 0;
    const runner: AgentModelRunner = {
      async runTurn() {
        modelTurnCount += 1;
        if (modelTurnCount === 1) {
          return makeAssistantResult({
            stopReason: "toolUse",
            content: [
              {
                type: "toolCall",
                id: "tool_1",
                name: "bash",
                arguments: {
                  command: "echo hi > notes.txt",
                },
              },
            ],
          });
        }

        if (modelTurnCount === 2) {
          return makeAssistantResult({
            stopReason: "toolUse",
            content: [
              {
                type: "toolCall",
                id: "tool_2",
                name: "bash",
                arguments: {
                  command: "echo hi > notes.txt",
                  sandboxMode: "full_access",
                  justification: "Need to write the requested note.",
                },
              },
            ],
          });
        }

        return makeAssistantResult({
          content: [{ type: "text", text: "done" }],
        });
      },
    };

    executeSandboxedBashMock.mockRejectedValueOnce(
      toolRecoverableError("Write access is missing for /tmp/notes.txt", {
        code: "permission_denied",
        requestable: true,
        failedToolCallId: "tool_1",
        summary: "Write access is missing for /tmp/notes.txt",
        guidance:
          "Review whether running this bash command with full access is necessary and legitimate for the current user request.\nIf it is necessary, rerun the bash tool with full-access approval fields.\nIf it is not necessary, do not request escalation.",
        entries: [
          {
            resource: "filesystem",
            path: "/tmp/notes.txt",
            scope: "exact",
            access: "write",
          },
        ],
        bashContext: {
          command: "echo hi > notes.txt",
          cwd: "/tmp",
          exitCode: 1,
          signal: null,
          stdout: "",
          stderr: "permission denied",
        },
      }),
    );
    executeUnsandboxedBashMock.mockResolvedValueOnce({
      command: "echo hi > notes.txt",
      cwd: "/tmp",
      timeoutMs: 10_000,
      stdout: "",
      stderr: "",
      exitCode: 0,
      signal: null,
    });

    const tools = new ToolRegistry([createBashTool()]);
    const emittedEvents: Array<{ type: string; approvalId?: string; decision?: string }> = [];
    const loop = new AgentLoop({
      sessions: new AgentSessionService(sessionsRepo, messagesRepo),
      messages: messagesRepo,
      models: new ProviderRegistry(createModelConfig()),
      tools,
      cancel: new SessionRunAbortRegistry(),
      modelRunner: runner,
      storage: handle.storage.db,
      securityConfig: DEFAULT_CONFIG.security,
      compaction: DEFAULT_CONFIG.compaction,
      emitEvent(event) {
        emittedEvents.push(event);
      },
    });

    const runPromise = loop.run({ sessionId: "sess_1", scenario: "chat" });
    const approvalId = Number(await waitForApprovalRequested(emittedEvents));

    expect(
      loop.submitApprovalResponse({
        approvalId,
        decision: "approve",
        actor: "user",
        rawInput: "approve",
        grantedBy: "user",
        expiresAt: null,
      }),
    ).toBe(true);

    const result = await runPromise;

    expect(executeSandboxedBashMock).toHaveBeenCalledTimes(1);
    expect(executeUnsandboxedBashMock).toHaveBeenCalledTimes(1);
    expect(result.events.some((event) => event.type === "approval_requested")).toBe(true);
    expect(
      result.events.some(
        (event) => event.type === "approval_resolved" && event.decision === "approve",
      ),
    ).toBe(true);

    const rows = messagesRepo.listBySession("sess_1");
    expect(rows).toHaveLength(6);
    expect(JSON.parse(rows[2]?.payloadJson ?? "{}")).toMatchObject({
      toolCallId: "tool_1",
      toolName: "bash",
      isError: true,
      details: {
        code: "permission_denied",
      },
    });
    expect(JSON.parse(rows[3]?.payloadJson ?? "{}")).toMatchObject({
      content: [
        {
          type: "toolCall",
          id: "tool_2",
          name: "bash",
        },
      ],
    });
    expect(JSON.parse(rows[4]?.payloadJson ?? "{}")).toMatchObject({
      toolCallId: "tool_2",
      toolName: "bash",
      isError: false,
      content: expect.arrayContaining([
        {
          type: "text",
          text: expect.stringContaining("<bash_result>"),
        },
      ]),
    });
  });

  test("explains when the retried bash call hits a new permission boundary", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    const messagesRepo = new MessagesRepo(handle.storage.db);
    sessionsRepo.create({
      id: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      ownerAgentId: "agent_1",
      purpose: "chat",
      createdAt: new Date("2026-03-22T00:00:00.000Z"),
    });
    messagesRepo.append({
      id: "msg_user",
      sessionId: "sess_1",
      seq: 1,
      role: "user",
      payloadJson: '{"content":"write the note"}',
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
    });

    let modelTurnCount = 0;
    const runner: AgentModelRunner = {
      async runTurn() {
        modelTurnCount += 1;
        if (modelTurnCount === 1) {
          return makeAssistantResult({
            stopReason: "toolUse",
            content: [
              {
                type: "toolCall",
                id: "tool_1",
                name: "bash",
                arguments: {
                  command: "cat /tmp/one && cat /tmp/two",
                },
              },
            ],
          });
        }

        if (modelTurnCount === 2) {
          return makeAssistantResult({
            stopReason: "toolUse",
            content: [
              {
                type: "toolCall",
                id: "tool_2",
                name: "bash",
                arguments: {
                  command: "cat /tmp/one && cat /tmp/two",
                  sandboxMode: "full_access",
                  justification: "Need to read the requested files.",
                },
              },
            ],
          });
        }

        return makeAssistantResult({
          content: [{ type: "text", text: "done" }],
        });
      },
    };

    executeSandboxedBashMock.mockRejectedValueOnce(
      toolRecoverableError("Read access is missing for /tmp/one", {
        code: "permission_denied",
        requestable: true,
        failedToolCallId: "tool_1",
        summary: "Read access is missing for /tmp/one",
        guidance:
          "Review whether running this bash command with full access is necessary and legitimate for the current user request.\nIf it is necessary, rerun the bash tool with full-access approval fields.\nIf it is not necessary, do not request escalation.",
        entries: [
          {
            resource: "filesystem",
            path: "/tmp/one",
            scope: "exact",
            access: "read",
          },
        ],
        bashContext: {
          command: "cat /tmp/one && cat /tmp/two",
          cwd: "/tmp",
          exitCode: 1,
          signal: null,
          stdout: "",
          stderr: "permission denied",
        },
      }),
    );
    executeUnsandboxedBashMock.mockRejectedValueOnce(
      toolRecoverableError("Read access is missing for /tmp/two", {
        code: "permission_denied",
        requestable: true,
        failedToolCallId: "tool_2",
        summary: "Read access is missing for /tmp/two",
        guidance:
          "Review whether running this bash command with full access is necessary and legitimate for the current user request.\nIf it is necessary, rerun the bash tool with full-access approval fields.\nIf it is not necessary, do not request escalation.",
        entries: [
          {
            resource: "filesystem",
            path: "/tmp/two",
            scope: "exact",
            access: "read",
          },
        ],
        bashContext: {
          command: "cat /tmp/one && cat /tmp/two",
          cwd: "/tmp",
          exitCode: 1,
          signal: null,
          stdout: "",
          stderr: "permission denied",
        },
      }),
    );

    const tools = new ToolRegistry([createBashTool()]);
    const emittedEvents: Array<{ type: string; approvalId?: string; decision?: string }> = [];
    const loop = new AgentLoop({
      sessions: new AgentSessionService(sessionsRepo, messagesRepo),
      messages: messagesRepo,
      models: new ProviderRegistry(createModelConfig()),
      tools,
      cancel: new SessionRunAbortRegistry(),
      modelRunner: runner,
      storage: handle.storage.db,
      securityConfig: DEFAULT_CONFIG.security,
      compaction: DEFAULT_CONFIG.compaction,
      emitEvent(event) {
        emittedEvents.push(event);
      },
    });

    const runPromise = loop.run({ sessionId: "sess_1", scenario: "chat" });
    const approvalId = Number(await waitForApprovalRequested(emittedEvents));

    expect(
      loop.submitApprovalResponse({
        approvalId,
        decision: "approve",
        actor: "user",
        rawInput: "approve",
        grantedBy: "user",
        expiresAt: null,
      }),
    ).toBe(true);

    await runPromise;

    const rows = messagesRepo.listBySession("sess_1");
    expect(JSON.parse(rows[4]?.payloadJson ?? "{}")).toMatchObject({
      toolCallId: "tool_2",
      toolName: "bash",
      isError: true,
      content: expect.arrayContaining([
        {
          type: "text",
          text: expect.stringContaining("<permission_block>"),
        },
      ]),
    });
  });
});
