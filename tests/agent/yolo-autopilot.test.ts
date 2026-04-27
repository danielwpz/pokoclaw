import { setTimeout as delay } from "node:timers/promises";
import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, test } from "vitest";

import type { AgentRuntimeEvent } from "@/src/agent/events.js";
import type { AgentAssistantContentBlock } from "@/src/agent/llm/messages.js";
import { ProviderRegistry } from "@/src/agent/llm/provider-registry.js";
import { AgentLoop, type AgentModelRunner } from "@/src/agent/loop.js";
import { AgentSessionService } from "@/src/agent/session.js";
import { DEFAULT_CONFIG } from "@/src/config/defaults.js";
import type { AppConfig } from "@/src/config/schema.js";
import { SessionRunAbortRegistry } from "@/src/runtime/cancel.js";
import { RuntimeModeService } from "@/src/runtime/runtime-modes.js";
import { ApprovalsRepo } from "@/src/storage/repos/approvals.repo.js";
import { MessagesRepo } from "@/src/storage/repos/messages.repo.js";
import { PermissionGrantsRepo } from "@/src/storage/repos/permission-grants.repo.js";
import { SessionsRepo } from "@/src/storage/repos/sessions.repo.js";
import { toolApprovalRequired, toolRecoverableError } from "@/src/tools/core/errors.js";
import { ToolRegistry } from "@/src/tools/core/registry.js";
import { defineTool, textToolResult } from "@/src/tools/core/types.js";
import { createFilesystemAccessController } from "@/src/tools/helpers/common.js";
import { createRequestPermissionsTool } from "@/src/tools/request-permissions.js";
import {
  createTestDatabase,
  destroyTestDatabase,
  type TestDatabaseHandle,
} from "@/tests/storage/helpers/test-db.js";

const NO_ARGS_TOOL_SCHEMA = Type.Object({}, { additionalProperties: false });
const LOOP_PROTECTED_FILE = "/tmp/pokoclaw-loop-protected.txt";

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
        task: ["anthropic_main/claude-sonnet-4-5"],
        meditationBucket: [],
        meditationConsolidation: [],
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

function seedSession(
  handle: TestDatabaseHandle,
  content: string,
): {
  sessionsRepo: SessionsRepo;
  messagesRepo: MessagesRepo;
} {
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
    payloadJson: JSON.stringify({ content }),
    createdAt: new Date("2026-03-22T00:00:01.000Z"),
  });
  return { sessionsRepo, messagesRepo };
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

async function waitForApprovalRequestCount(
  events: Array<{ type: string; approvalId?: string }>,
  count: number,
): Promise<string[]> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const approvalIds = events
      .filter((event) => event.type === "approval_requested")
      .map((event) => event.approvalId)
      .filter((approvalId): approvalId is string => approvalId != null);
    if (approvalIds.length >= count) {
      return approvalIds;
    }

    await delay(5);
  }

  throw new Error(`Expected ${count} approval requests to be emitted`);
}

describe("agent loop yolo and autopilot", () => {
  let handle: TestDatabaseHandle | null = null;

  afterEach(async () => {
    if (handle != null) {
      await destroyTestDatabase(handle);
      handle = null;
    }
  });

  test("yolo skips request_permissions approval and retries with ephemeral filesystem scopes", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    const { sessionsRepo, messagesRepo } = seedSession(handle, "update the file");
    const runtimeModes = new RuntimeModeService({
      storage: handle.storage.db,
      autopilotEnabled: false,
    });
    runtimeModes.toggleYolo({
      ownerAgentId: "agent_1",
      updatedAt: new Date("2026-03-22T00:00:02.000Z"),
    });

    let modelTurnCount = 0;
    let toolExecuteCount = 0;
    const runner: AgentModelRunner = {
      async runTurn() {
        modelTurnCount += 1;
        if (modelTurnCount === 1) {
          return makeAssistantResult({
            stopReason: "toolUse",
            content: [{ type: "toolCall", id: "tool_1", name: "gated", arguments: {} }],
          });
        }

        if (modelTurnCount === 2) {
          return makeAssistantResult({
            stopReason: "toolUse",
            content: [
              {
                type: "toolCall",
                id: "tool_2",
                name: "request_permissions",
                arguments: {
                  entries: [
                    {
                      resource: "filesystem",
                      path: LOOP_PROTECTED_FILE,
                      scope: "exact",
                      access: "write",
                    },
                  ],
                  justification: "Need to write the requested note.",
                  retryToolCallId: "tool_1",
                },
              },
            ],
          });
        }

        if (modelTurnCount === 3) {
          return makeAssistantResult({
            stopReason: "toolUse",
            content: [{ type: "toolCall", id: "tool_3", name: "gated", arguments: {} }],
          });
        }

        return makeAssistantResult({
          content: [{ type: "text", text: "done" }],
        });
      },
    };

    const tools = new ToolRegistry([
      defineTool({
        name: "gated",
        description: "Needs approval first",
        inputSchema: NO_ARGS_TOOL_SCHEMA,
        execute(context) {
          toolExecuteCount += 1;
          const hasEphemeralWrite = context.approvalState?.ephemeralPermissionScopes?.some(
            (scope) =>
              scope.kind === "fs.write" && "path" in scope && scope.path === LOOP_PROTECTED_FILE,
          );
          if (hasEphemeralWrite !== true) {
            throw toolRecoverableError("Write access is missing for workspace notes.", {
              code: "permission_denied",
              requestable: true,
              failedToolCallId: "tool_1",
              summary: "Write access is missing for workspace notes.",
              entries: [
                {
                  resource: "filesystem",
                  path: LOOP_PROTECTED_FILE,
                  scope: "exact",
                  access: "write",
                },
              ],
            });
          }

          return textToolResult("ok");
        },
      }),
      createRequestPermissionsTool(),
    ]);

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
      runtimeModes,
    });

    const result = await loop.run({ sessionId: "sess_1", scenario: "chat" });

    expect(toolExecuteCount).toBe(3);
    expect(
      result.events.some(
        (event) => event.type === "approval_requested" || event.type === "approval_resolved",
      ),
    ).toBe(false);
    expect(new PermissionGrantsRepo(handle.storage.db).listByOwner("agent_1")).toEqual([]);
    expect(new ApprovalsRepo(handle.storage.db).listByOwner("agent_1")).toMatchObject([
      {
        status: "approved",
      },
    ]);
  });

  test("yolo lets filesystem tools proceed without first returning an approval block", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    const { sessionsRepo, messagesRepo } = seedSession(handle, "write directly");
    const runtimeModes = new RuntimeModeService({
      storage: handle.storage.db,
      autopilotEnabled: false,
    });
    runtimeModes.toggleYolo({
      ownerAgentId: "agent_1",
      updatedAt: new Date("2026-03-22T00:00:02.000Z"),
    });

    let modelTurnCount = 0;
    let toolExecuteCount = 0;
    const runner: AgentModelRunner = {
      async runTurn() {
        modelTurnCount += 1;
        if (modelTurnCount === 1) {
          return makeAssistantResult({
            stopReason: "toolUse",
            content: [{ type: "toolCall", id: "tool_1", name: "direct_write", arguments: {} }],
          });
        }

        return makeAssistantResult({
          content: [{ type: "text", text: "done" }],
        });
      },
    };

    const tools = new ToolRegistry([
      defineTool({
        name: "direct_write",
        description: "Uses the normal filesystem access controller",
        inputSchema: NO_ARGS_TOOL_SCHEMA,
        execute(context) {
          toolExecuteCount += 1;
          createFilesystemAccessController(context).require({
            kind: "fs.write",
            targetPath: LOOP_PROTECTED_FILE,
          });
          return textToolResult("ok");
        },
      }),
    ]);

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
      runtimeModes,
    });

    const result = await loop.run({ sessionId: "sess_1", scenario: "chat" });

    expect(toolExecuteCount).toBe(1);
    expect(result.events.some((event) => event.type === "tool_call_failed")).toBe(false);
    expect(
      result.events.some(
        (event) => event.type === "approval_requested" || event.type === "approval_resolved",
      ),
    ).toBe(false);
    expect(new ApprovalsRepo(handle.storage.db).listByOwner("agent_1")).toEqual([]);
  });

  test("autopilot skips bash full_access approval as one-shot without durable grants", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    const { sessionsRepo, messagesRepo } = seedSession(handle, "run full access command");
    const runtimeModes = new RuntimeModeService({
      storage: handle.storage.db,
      autopilotEnabled: true,
    });
    let toolExecuteCount = 0;
    const runner: AgentModelRunner = {
      async runTurn() {
        if (toolExecuteCount === 0) {
          return makeAssistantResult({
            stopReason: "toolUse",
            content: [{ type: "toolCall", id: "tool_1", name: "full_access_step", arguments: {} }],
          });
        }

        return makeAssistantResult({
          content: [{ type: "text", text: "done" }],
        });
      },
    };

    const tools = new ToolRegistry([
      defineTool({
        name: "full_access_step",
        description: "Needs full access first",
        inputSchema: NO_ARGS_TOOL_SCHEMA,
        execute(context) {
          toolExecuteCount += 1;
          if (context.approvalState?.bashFullAccess?.approved === true) {
            return textToolResult("ok");
          }

          throw toolApprovalRequired({
            request: {
              scopes: [{ kind: "bash.full_access", prefix: ["git"] }],
            },
            reasonText: "Need to run git with full access.",
            grantOnApprove: true,
          });
        },
      }),
    ]);

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
      runtimeModes,
    });

    const result = await loop.run({ sessionId: "sess_1", scenario: "chat" });

    expect(toolExecuteCount).toBe(2);
    expect(
      result.events.some(
        (event) => event.type === "approval_requested" || event.type === "approval_resolved",
      ),
    ).toBe(false);
    expect(new PermissionGrantsRepo(handle.storage.db).listByOwner("agent_1")).toEqual([]);
    expect(new ApprovalsRepo(handle.storage.db).listByOwner("agent_1")).toMatchObject([
      {
        status: "approved",
      },
    ]);
  });

  test("emits a yolo suggestion after two user approvals in the streak window", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    const { sessionsRepo, messagesRepo } = seedSession(handle, "run two gated steps");
    const runtimeModes = new RuntimeModeService({
      storage: handle.storage.db,
      autopilotEnabled: false,
    });
    let modelTurnCount = 0;
    let toolExecuteCount = 0;
    const runner: AgentModelRunner = {
      async runTurn() {
        modelTurnCount += 1;
        if (modelTurnCount <= 2) {
          return makeAssistantResult({
            stopReason: "toolUse",
            content: [
              {
                type: "toolCall",
                id: `tool_${modelTurnCount}`,
                name: "needs_approval",
                arguments: {},
              },
            ],
          });
        }

        return makeAssistantResult({
          content: [{ type: "text", text: "done" }],
        });
      },
    };

    const tools = new ToolRegistry([
      defineTool({
        name: "needs_approval",
        description: "Approval-gated step",
        inputSchema: NO_ARGS_TOOL_SCHEMA,
        execute() {
          toolExecuteCount += 1;
          if (toolExecuteCount % 2 === 1) {
            throw toolApprovalRequired({
              request: {
                scopes: [{ kind: "db.read", database: "system" }],
              },
              reasonText: "Need database read for diagnostics.",
              grantOnApprove: false,
            });
          }

          return textToolResult("ok");
        },
      }),
    ]);

    const emittedEvents: AgentRuntimeEvent[] = [];
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
      runtimeModes,
      emitEvent(event) {
        emittedEvents.push(event);
      },
    });

    const runPromise = loop.run({ sessionId: "sess_1", scenario: "chat" });
    const firstApprovalId = Number((await waitForApprovalRequestCount(emittedEvents, 1))[0]);
    expect(
      loop.submitApprovalResponse({
        approvalId: firstApprovalId,
        decision: "approve",
        actor: "user",
        rawInput: "approve",
        grantedBy: "user",
      }),
    ).toBe(true);

    const secondApprovalId = Number((await waitForApprovalRequestCount(emittedEvents, 2))[1]);
    expect(emittedEvents.find((event) => event.type === "runtime_nudge")).toMatchObject({
      type: "runtime_nudge",
      ownerAgentId: "agent_1",
      anchor: {
        type: "approval_flow",
      },
      nudge: {
        kind: "yolo_suggestion",
        message:
          "💡 Too many approval stops? Send `/yolo` if you want this agent to keep going without asking each time.",
      },
    });
    expect(
      loop.submitApprovalResponse({
        approvalId: secondApprovalId,
        decision: "approve",
        actor: "user",
        rawInput: "approve",
        grantedBy: "user",
      }),
    ).toBe(true);

    const result = await runPromise;

    expect(toolExecuteCount).toBe(4);
    expect(result.events.some((event) => event.type === "runtime_nudge")).toBe(true);
  });
});
