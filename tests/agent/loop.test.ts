import { setTimeout as delay } from "node:timers/promises";
import { Type } from "@sinclair/typebox";

import { afterEach, describe, expect, test, vi } from "vitest";
import { AgentLlmError, normalizeAgentLlmError } from "@/src/agent/llm/errors.js";
import type { AgentAssistantContentBlock } from "@/src/agent/llm/messages.js";
import { ProviderRegistry } from "@/src/agent/llm/provider-registry.js";
import { AgentLoop, type AgentModelRunner } from "@/src/agent/loop.js";
import { buildMemoryCatalogPrompt } from "@/src/agent/memory.js";
import { AgentSessionService } from "@/src/agent/session.js";
import { buildSkillsCatalogPrompt } from "@/src/agent/skills.js";
import { DEFAULT_CONFIG } from "@/src/config/defaults.js";
import type { AppConfig } from "@/src/config/schema.js";
import { SessionRunAbortRegistry } from "@/src/runtime/cancel.js";
import { RuntimeControlService } from "@/src/runtime/control.js";
import {
  POKOCLAW_REPO_DIR,
  POKOCLAW_SKILLS_DIR,
  POKOCLAW_WORKSPACE_DIR,
} from "@/src/shared/paths.js";
import { resolveLocalCalendarContext } from "@/src/shared/time.js";
import { ApprovalsRepo } from "@/src/storage/repos/approvals.repo.js";
import { MessagesRepo } from "@/src/storage/repos/messages.repo.js";
import { SessionsRepo } from "@/src/storage/repos/sessions.repo.js";
import { toolRecoverableError } from "@/src/tools/core/errors.js";
import { ToolRegistry } from "@/src/tools/core/registry.js";
import { defineTool, textToolResult } from "@/src/tools/core/types.js";
import { createScheduleTaskTool } from "@/src/tools/cron.js";
import { createRequestPermissionsTool } from "@/src/tools/request-permissions.js";
import {
  createTestDatabase,
  destroyTestDatabase,
  type TestDatabaseHandle,
} from "@/tests/storage/helpers/test-db.js";

const TEST_BASH_TOOL_SCHEMA = Type.Object(
  {
    command: Type.String(),
    workdir: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
  },
  { additionalProperties: false },
);

const NO_ARGS_TOOL_SCHEMA = Type.Object({}, { additionalProperties: false });

function createModelConfig(
  options: { supportsTools?: boolean } = {},
): Pick<AppConfig, "providers" | "models"> {
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
          supportsTools: options.supportsTools ?? true,
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

function seedConversationFixture(handle: TestDatabaseHandle): void {
  handle.storage.sqlite.exec(`
    INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
    VALUES ('ci_1', 'lark', 'acct_a', '2026-03-22T00:00:00.000Z', '2026-03-22T00:00:00.000Z');

    INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
    VALUES ('conv_1', 'ci_1', 'chat_1', 'dm', '2026-03-22T00:00:00.000Z', '2026-03-22T00:00:00.000Z');

    INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
    VALUES ('branch_1', 'conv_1', 'dm_main', 'main', '2026-03-22T00:00:00.000Z', '2026-03-22T00:00:00.000Z');
  `);
}

function seedConversationAndAgentFixture(handle: TestDatabaseHandle): void {
  seedConversationFixture(handle);
  handle.storage.sqlite.exec(`
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

async function waitForSessionCompaction(
  sessionsRepo: SessionsRepo,
  sessionId: string,
): Promise<ReturnType<SessionsRepo["getById"]>> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const session = sessionsRepo.getById(sessionId);
    if (session?.compactCursor === 2) {
      return session;
    }

    await delay(5);
  }

  return sessionsRepo.getById(sessionId);
}

async function waitForApprovalRequested(
  events: Array<{ type: string; approvalId?: string }>,
): Promise<string> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const approvalId = events.find((event) => event.type === "approval_requested")?.approvalId;
    if (approvalId != null) {
      return approvalId;
    }

    await delay(5);
  }

  throw new Error("Approval request was not emitted");
}

const LOOP_PROTECTED_FILE = "/tmp/pokoclaw-loop-protected.txt";

describe("agent loop", () => {
  let handle: TestDatabaseHandle | null = null;

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (handle != null) {
      await destroyTestDatabase(handle);
      handle = null;
    }
  });

  test("persists a plain assistant reply for a single session turn", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationFixture(handle);

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    const messagesRepo = new MessagesRepo(handle.storage.db);
    sessionsRepo.create({
      id: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      purpose: "chat",
      createdAt: new Date("2026-03-22T00:00:00.000Z"),
    });
    messagesRepo.append({
      id: "msg_user",
      sessionId: "sess_1",
      seq: 1,
      role: "user",
      payloadJson: '{"content":"hello"}',
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
    });

    const runner: AgentModelRunner = {
      async runTurn() {
        return makeAssistantResult({
          content: [{ type: "text", text: "hi there" }],
        });
      },
    };

    const loop = new AgentLoop({
      sessions: new AgentSessionService(sessionsRepo, messagesRepo),
      messages: messagesRepo,
      models: new ProviderRegistry(createModelConfig()),
      tools: new ToolRegistry(),
      cancel: new SessionRunAbortRegistry(),
      modelRunner: runner,
      storage: handle.storage.db,
      securityConfig: DEFAULT_CONFIG.security,
      compaction: DEFAULT_CONFIG.compaction,
    });

    const result = await loop.run({ sessionId: "sess_1", scenario: "chat" });

    const rows = messagesRepo.listBySession("sess_1");
    expect(rows).toHaveLength(2);
    expect(JSON.parse(rows[1]?.payloadJson ?? "{}")).toEqual({
      content: [{ type: "text", text: "hi there" }],
    });
    expect(rows[1]?.provider).toBe("anthropic_main");
    expect(rows[1]?.model).toBe("claude-sonnet-4-5");
    expect(rows[1]?.modelApi).toBe("anthropic-messages");
    expect(rows[1]?.stopReason).toBe("stop");
    expect(result.toolExecutions).toBe(0);
    expect(result.events.map((event) => event.type)).toEqual([
      "run_started",
      "turn_started",
      "assistant_message_started",
      "assistant_message_delta",
      "assistant_message_completed",
      "turn_completed",
      "run_completed",
    ]);
  });

  test("keeps running when an external message is appended mid-run during a tool call", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationFixture(handle);

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    const messagesRepo = new MessagesRepo(handle.storage.db);
    sessionsRepo.create({
      id: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      purpose: "chat",
      createdAt: new Date("2026-03-22T00:00:00.000Z"),
    });
    messagesRepo.append({
      id: "msg_user",
      sessionId: "sess_1",
      seq: 1,
      role: "user",
      payloadJson: '{"content":"run tool"}',
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
    });

    let turns = 0;
    const runner: AgentModelRunner = {
      async runTurn() {
        turns += 1;
        if (turns === 1) {
          return makeAssistantResult({
            stopReason: "toolUse",
            content: [
              {
                type: "toolCall",
                id: "call_1",
                name: "inject_notice",
                arguments: {},
              },
            ],
          });
        }

        return makeAssistantResult({
          content: [{ type: "text", text: "done after tool" }],
        });
      },
    };

    const loop = new AgentLoop({
      sessions: new AgentSessionService(sessionsRepo, messagesRepo),
      messages: messagesRepo,
      models: new ProviderRegistry(createModelConfig()),
      tools: new ToolRegistry([
        defineTool({
          name: "inject_notice",
          description: "inject hidden notice while run is active",
          inputSchema: NO_ARGS_TOOL_SCHEMA,
          execute() {
            messagesRepo.append({
              id: "msg_external_notice",
              sessionId: "sess_1",
              seq: messagesRepo.getNextSeq("sess_1"),
              role: "user",
              messageType: "background_task_completion",
              visibility: "hidden_system",
              payloadJson: JSON.stringify({
                content: '<system_event type="background_task_completion">injected</system_event>',
              }),
              createdAt: new Date("2026-03-22T00:00:02.000Z"),
            });
            return textToolResult("injected");
          },
        }),
      ]),
      cancel: new SessionRunAbortRegistry(),
      modelRunner: runner,
      storage: handle.storage.db,
      securityConfig: DEFAULT_CONFIG.security,
      compaction: DEFAULT_CONFIG.compaction,
    });

    const result = await loop.run({ sessionId: "sess_1", scenario: "chat" });

    expect(result.events.some((event) => event.type === "run_failed")).toBe(false);
    const rows = messagesRepo.listBySession("sess_1");
    expect(rows.map((row) => row.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(rows.find((row) => row.messageType === "background_task_completion")).toMatchObject({
      id: "msg_external_notice",
      visibility: "hidden_system",
    });
    expect(JSON.parse(rows.at(-1)?.payloadJson ?? "{}")).toEqual({
      content: [{ type: "text", text: "done after tool" }],
    });
  });

  test("reuses a cached next seq across multiple appends in one run", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationFixture(handle);

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    const messagesRepo = new MessagesRepo(handle.storage.db);
    sessionsRepo.create({
      id: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      purpose: "chat",
      createdAt: new Date("2026-03-22T00:00:00.000Z"),
    });
    messagesRepo.append({
      id: "msg_user",
      sessionId: "sess_1",
      seq: 1,
      role: "user",
      payloadJson: '{"content":"hello"}',
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
    });

    let turns = 0;
    const runner: AgentModelRunner = {
      async runTurn() {
        turns += 1;
        if (turns === 1) {
          return makeAssistantResult({
            stopReason: "toolUse",
            content: [
              {
                type: "toolCall",
                id: "call_1",
                name: "ping",
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

    const getNextSeqSpy = vi.spyOn(messagesRepo, "getNextSeq");
    const loop = new AgentLoop({
      sessions: new AgentSessionService(sessionsRepo, messagesRepo),
      messages: messagesRepo,
      models: new ProviderRegistry(createModelConfig()),
      tools: new ToolRegistry([
        defineTool({
          name: "ping",
          description: "no-op",
          inputSchema: NO_ARGS_TOOL_SCHEMA,
          execute() {
            return textToolResult("pong");
          },
        }),
      ]),
      cancel: new SessionRunAbortRegistry(),
      modelRunner: runner,
      storage: handle.storage.db,
      securityConfig: DEFAULT_CONFIG.security,
      compaction: DEFAULT_CONFIG.compaction,
    });

    await loop.run({ sessionId: "sess_1", scenario: "chat" });

    expect(getNextSeqSpy).toHaveBeenCalledOnce();
  });

  test("refreshes next seq and retries after a unique constraint collision", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationFixture(handle);

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    const messagesRepo = new MessagesRepo(handle.storage.db);
    sessionsRepo.create({
      id: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      purpose: "chat",
      createdAt: new Date("2026-03-22T00:00:00.000Z"),
    });
    messagesRepo.append({
      id: "msg_user",
      sessionId: "sess_1",
      seq: 1,
      role: "user",
      payloadJson: '{"content":"hello"}',
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
    });

    const runner: AgentModelRunner = {
      async runTurn() {
        return makeAssistantResult({
          content: [{ type: "text", text: "hi there" }],
        });
      },
    };

    const originalAppend = messagesRepo.append.bind(messagesRepo);
    const getNextSeqSpy = vi.spyOn(messagesRepo, "getNextSeq");
    let injectedCollision = false;
    vi.spyOn(messagesRepo, "append").mockImplementation((input) => {
      if (!injectedCollision && input.sessionId === "sess_1" && input.role === "assistant") {
        injectedCollision = true;
        originalAppend({
          id: "msg_external_notice",
          sessionId: "sess_1",
          seq: input.seq,
          role: "user",
          messageType: "background_task_completion",
          visibility: "hidden_system",
          payloadJson: JSON.stringify({
            content: '<system_event type="background_task_completion">raced</system_event>',
          }),
          createdAt: new Date("2026-03-22T00:00:01.500Z"),
        });
        const error = new Error(
          "UNIQUE constraint failed: messages.session_id, messages.seq",
        ) as Error & { code?: string };
        error.code = "SQLITE_CONSTRAINT_UNIQUE";
        throw error;
      }
      return originalAppend(input);
    });

    const loop = new AgentLoop({
      sessions: new AgentSessionService(sessionsRepo, messagesRepo),
      messages: messagesRepo,
      models: new ProviderRegistry(createModelConfig()),
      tools: new ToolRegistry(),
      cancel: new SessionRunAbortRegistry(),
      modelRunner: runner,
      storage: handle.storage.db,
      securityConfig: DEFAULT_CONFIG.security,
      compaction: DEFAULT_CONFIG.compaction,
    });

    const result = await loop.run({ sessionId: "sess_1", scenario: "chat" });

    expect(result.events.some((event) => event.type === "run_failed")).toBe(false);
    expect(getNextSeqSpy).toHaveBeenCalledTimes(2);
    const rows = messagesRepo.listBySession("sess_1");
    expect(rows.map((row) => row.seq)).toEqual([1, 2, 3]);
    expect(rows[1]?.messageType).toBe("background_task_completion");
    expect(JSON.parse(rows[2]?.payloadJson ?? "{}")).toEqual({
      content: [{ type: "text", text: "hi there" }],
    });
  });

  test("keeps image bytes only for the active user turn across multi-request runs", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationFixture(handle);

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    const messagesRepo = new MessagesRepo(handle.storage.db);
    sessionsRepo.create({
      id: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      purpose: "chat",
      createdAt: new Date("2026-03-22T00:00:00.000Z"),
    });
    messagesRepo.append({
      id: "msg_user",
      sessionId: "sess_1",
      seq: 1,
      role: "user",
      payloadJson: JSON.stringify({
        content: "[图片 img_v3_123]",
        images: [
          {
            type: "image",
            id: "img_v3_123",
            messageId: "om_msg_1",
            mimeType: "image/png",
          },
        ],
      }),
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
    });

    const seenRuntimeImageCounts: number[] = [];
    let turns = 0;
    const runner: AgentModelRunner = {
      async runTurn(input) {
        const userMessage = input.messages.find((message) => message.id === "msg_user");
        seenRuntimeImageCounts.push(
          userMessage == null ? -1 : (input.resolveRuntimeImages?.(userMessage).length ?? 0),
        );
        turns += 1;
        if (turns === 1) {
          return makeAssistantResult({
            stopReason: "toolUse",
            content: [
              {
                type: "toolCall",
                id: "call_1",
                name: "ping",
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

    const loop = new AgentLoop({
      sessions: new AgentSessionService(sessionsRepo, messagesRepo),
      messages: messagesRepo,
      models: new ProviderRegistry(createModelConfig()),
      tools: new ToolRegistry([
        defineTool({
          name: "ping",
          description: "no-op",
          inputSchema: NO_ARGS_TOOL_SCHEMA,
          execute() {
            return textToolResult("pong");
          },
        }),
      ]),
      cancel: new SessionRunAbortRegistry(),
      modelRunner: runner,
      storage: handle.storage.db,
      securityConfig: DEFAULT_CONFIG.security,
      compaction: DEFAULT_CONFIG.compaction,
    });

    await loop.run({
      sessionId: "sess_1",
      scenario: "chat",
      initialRuntimeImagesByMessageId: {
        msg_user: [
          {
            type: "image",
            id: "img_v3_123",
            messageId: "om_msg_1",
            data: "ZmFrZS1pbWFnZQ==",
            mimeType: "image/png",
          },
        ],
      },
    });

    expect(seenRuntimeImageCounts).toEqual([1, 1]);
    expect(JSON.parse(messagesRepo.listBySession("sess_1")[0]?.payloadJson ?? "{}")).toEqual({
      content: "[图片 img_v3_123]",
      images: [
        {
          type: "image",
          id: "img_v3_123",
          messageId: "om_msg_1",
          mimeType: "image/png",
        },
      ],
    });

    messagesRepo.append({
      id: "msg_user_2",
      sessionId: "sess_1",
      seq: messagesRepo.getNextSeq("sess_1"),
      role: "user",
      payloadJson: JSON.stringify({ content: "follow-up" }),
      createdAt: new Date("2026-03-22T00:00:02.000Z"),
    });

    const secondRunSeenCounts: number[] = [];
    const secondRunRunner: AgentModelRunner = {
      async runTurn(input) {
        for (const message of input.messages.filter((entry) => entry.role === "user")) {
          secondRunSeenCounts.push(input.resolveRuntimeImages?.(message).length ?? 0);
        }
        return makeAssistantResult({
          content: [{ type: "text", text: "follow-up done" }],
        });
      },
    };

    const secondLoop = new AgentLoop({
      sessions: new AgentSessionService(sessionsRepo, messagesRepo),
      messages: messagesRepo,
      models: new ProviderRegistry(createModelConfig()),
      tools: new ToolRegistry(),
      cancel: new SessionRunAbortRegistry(),
      modelRunner: secondRunRunner,
      storage: handle.storage.db,
      securityConfig: DEFAULT_CONFIG.security,
      compaction: DEFAULT_CONFIG.compaction,
    });

    await secondLoop.run({ sessionId: "sess_1", scenario: "chat" });

    expect(secondRunSeenCounts).toEqual([0, 0]);
  });

  test("captures runtime date context once per run so multi-turn prompts keep a stable prefix", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-30T05:47:00.000Z"));

    handle = await createTestDatabase(import.meta.url);
    seedConversationFixture(handle);

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    const messagesRepo = new MessagesRepo(handle.storage.db);
    handle.storage.sqlite.exec(`
      INSERT INTO agents (id, conversation_id, kind, created_at)
      VALUES ('agent_main', 'conv_1', 'main', '2026-03-22T00:00:00.000Z');
    `);
    sessionsRepo.create({
      id: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      ownerAgentId: "agent_main",
      purpose: "chat",
      createdAt: new Date("2026-03-22T00:00:00.000Z"),
    });
    messagesRepo.append({
      id: "msg_user",
      sessionId: "sess_1",
      seq: 1,
      role: "user",
      payloadJson: '{"content":"Remind me about my 3 PM meeting this afternoon."}',
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
    });

    const seenSystemPrompts: string[] = [];
    let turns = 0;
    const runner: AgentModelRunner = {
      async runTurn(input) {
        seenSystemPrompts.push(input.systemPrompt ?? "");
        turns += 1;
        if (turns === 1) {
          return makeAssistantResult({
            stopReason: "toolUse",
            content: [
              {
                type: "toolCall",
                id: "call_1",
                name: "ping",
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

    const loop = new AgentLoop({
      sessions: new AgentSessionService(sessionsRepo, messagesRepo),
      messages: messagesRepo,
      models: new ProviderRegistry(createModelConfig()),
      tools: new ToolRegistry([
        defineTool({
          name: "ping",
          description: "no-op",
          inputSchema: NO_ARGS_TOOL_SCHEMA,
          execute() {
            return textToolResult("pong");
          },
        }),
      ]),
      cancel: new SessionRunAbortRegistry(),
      modelRunner: runner,
      storage: handle.storage.db,
      securityConfig: DEFAULT_CONFIG.security,
      compaction: DEFAULT_CONFIG.compaction,
    });

    await loop.run({ sessionId: "sess_1", scenario: "chat" });

    const runtimeContext = resolveLocalCalendarContext(new Date("2026-03-30T05:47:00.000Z"));
    expect(seenSystemPrompts).toHaveLength(2);
    expect(seenSystemPrompts[0]).toBe(seenSystemPrompts[1]);
    expect(seenSystemPrompts[0]).toContain("## Workspace & Runtime");
    expect(seenSystemPrompts[0]).toContain(`Current date: ${runtimeContext.currentDate}`);
    expect(seenSystemPrompts[0]).toContain(`Time zone: ${runtimeContext.timezone}`);
  });

  test("resolves the skills catalog once per run and reuses the frozen prompt across turns", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationFixture(handle);

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    const messagesRepo = new MessagesRepo(handle.storage.db);
    handle.storage.sqlite.exec(`
      INSERT INTO agents (id, conversation_id, kind, created_at)
      VALUES ('agent_main', 'conv_1', 'main', '2026-03-22T00:00:00.000Z');
    `);
    sessionsRepo.create({
      id: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      ownerAgentId: "agent_main",
      purpose: "chat",
      createdAt: new Date("2026-03-22T00:00:00.000Z"),
    });
    messagesRepo.append({
      id: "msg_user",
      sessionId: "sess_1",
      seq: 1,
      role: "user",
      payloadJson: '{"content":"help me review this repository"}',
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
    });

    const seenSystemPrompts: string[] = [];
    let turns = 0;
    let skillResolverCalls = 0;
    const runner: AgentModelRunner = {
      async runTurn(input) {
        seenSystemPrompts.push(input.systemPrompt ?? "");
        turns += 1;
        if (turns === 1) {
          return makeAssistantResult({
            stopReason: "toolUse",
            content: [
              {
                type: "toolCall",
                id: "call_1",
                name: "ping",
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

    const loop = new AgentLoop({
      sessions: new AgentSessionService(sessionsRepo, messagesRepo),
      messages: messagesRepo,
      models: new ProviderRegistry(createModelConfig()),
      tools: new ToolRegistry([
        defineTool({
          name: "ping",
          description: "no-op",
          inputSchema: NO_ARGS_TOOL_SCHEMA,
          execute() {
            return textToolResult("pong");
          },
        }),
      ]),
      skillsResolver: {
        resolveForRun() {
          skillResolverCalls += 1;
          const entries = [
            {
              name: "repo-review",
              description: "Review the current repository.",
              skillKey: "builtin:repo-review/SKILL.md",
              source: "builtin" as const,
              rootDir: `${POKOCLAW_REPO_DIR}/skills`,
              skillDir: `${POKOCLAW_REPO_DIR}/skills/repo-review`,
              skillFilePath: `${POKOCLAW_REPO_DIR}/skills/repo-review/SKILL.md`,
            },
          ];
          return {
            entries,
            warnings: [],
            prompt: buildSkillsCatalogPrompt(entries),
          };
        },
      },
      cancel: new SessionRunAbortRegistry(),
      modelRunner: runner,
      storage: handle.storage.db,
      securityConfig: DEFAULT_CONFIG.security,
      compaction: DEFAULT_CONFIG.compaction,
    });

    await loop.run({ sessionId: "sess_1", scenario: "chat" });

    expect(skillResolverCalls).toBe(1);
    expect(seenSystemPrompts).toHaveLength(2);
    expect(seenSystemPrompts[0]).toBe(seenSystemPrompts[1]);
    expect(seenSystemPrompts[0]).toContain("## Skills");
    expect(seenSystemPrompts[0]).toContain("<available_skills>");
    expect(seenSystemPrompts[0]).toContain("<name>repo-review</name>");
  });

  test("reuses the same memory snapshot across all turns in one run", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    const messagesRepo = new MessagesRepo(handle.storage.db);
    sessionsRepo.create({
      id: "sess_memory",
      conversationId: "conv_1",
      branchId: "branch_1",
      ownerAgentId: "agent_1",
      purpose: "chat",
      createdAt: new Date("2026-03-22T00:00:00.000Z"),
    });
    messagesRepo.append({
      id: "msg_memory",
      sessionId: "sess_memory",
      seq: 1,
      role: "user",
      payloadJson: '{"content":"who am I?"}',
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
    });

    const seenSystemPrompts: string[] = [];
    let turns = 0;
    let memoryResolverCalls = 0;
    const runner: AgentModelRunner = {
      async runTurn(input) {
        seenSystemPrompts.push(input.systemPrompt ?? "");
        turns += 1;
        if (turns === 1) {
          return makeAssistantResult({
            stopReason: "toolUse",
            content: [
              {
                type: "toolCall",
                id: "call_1",
                name: "ping",
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

    const loop = new AgentLoop({
      sessions: new AgentSessionService(sessionsRepo, messagesRepo),
      messages: messagesRepo,
      models: new ProviderRegistry(createModelConfig()),
      tools: new ToolRegistry([
        defineTool({
          name: "ping",
          description: "no-op",
          inputSchema: NO_ARGS_TOOL_SCHEMA,
          execute() {
            return textToolResult("pong");
          },
        }),
      ]),
      memoryResolver: {
        resolveForRun() {
          memoryResolverCalls += 1;
          const entries = [
            {
              layer: "soul" as const,
              path: "/tmp/ws/SOUL.md",
              purpose: "Identity, tone, boundaries, and stable user profile.",
              content: "User is a founder in Shanghai.",
            },
          ];
          return {
            entries,
            warnings: [],
            prompt: buildMemoryCatalogPrompt(entries),
          };
        },
      },
      cancel: new SessionRunAbortRegistry(),
      modelRunner: runner,
      storage: handle.storage.db,
      securityConfig: DEFAULT_CONFIG.security,
      compaction: DEFAULT_CONFIG.compaction,
    });

    await loop.run({ sessionId: "sess_memory", scenario: "chat" });

    expect(memoryResolverCalls).toBe(1);
    expect(seenSystemPrompts).toHaveLength(2);
    expect(seenSystemPrompts[0]).toBe(seenSystemPrompts[1]);
    expect(seenSystemPrompts[0]).toContain("## Memory");
    expect(seenSystemPrompts[0]).toContain("<memory_files>");
    expect(seenSystemPrompts[0]).toContain("User is a founder in Shanghai.");
  });

  test("injects bootstrap guidance for main chat runs when BOOTSTRAP.md is present", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationFixture(handle);

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    const messagesRepo = new MessagesRepo(handle.storage.db);
    handle.storage.sqlite.exec(`
      INSERT INTO agents (id, conversation_id, kind, created_at)
      VALUES ('agent_main', 'conv_1', 'main', '2026-03-22T00:00:00.000Z');
    `);
    sessionsRepo.create({
      id: "sess_bootstrap",
      conversationId: "conv_1",
      branchId: "branch_1",
      ownerAgentId: "agent_main",
      purpose: "chat",
      createdAt: new Date("2026-03-22T00:00:00.000Z"),
    });
    messagesRepo.append({
      id: "msg_bootstrap",
      sessionId: "sess_bootstrap",
      seq: 1,
      role: "user",
      payloadJson: '{"content":"hello"}',
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
    });

    const seenSystemPrompts: string[] = [];
    const runner: AgentModelRunner = {
      async runTurn(input) {
        seenSystemPrompts.push(input.systemPrompt ?? "");
        return makeAssistantResult({
          content: [{ type: "text", text: "hi" }],
        });
      },
    };

    const loop = new AgentLoop({
      sessions: new AgentSessionService(sessionsRepo, messagesRepo),
      messages: messagesRepo,
      models: new ProviderRegistry(createModelConfig()),
      tools: new ToolRegistry(),
      bootstrapResolver: {
        resolveForRun() {
          return {
            path: "/tmp/ws/BOOTSTRAP.md",
            content: "Ask what to call the user.\nAsk what the assistant should be called.",
            prompt: [
              "<bootstrap_file>",
              "The file below defines first-run bootstrap instructions for this session.",
              "  <path>/tmp/ws/BOOTSTRAP.md</path>",
              "  <content>",
              "    Ask what to call the user.",
              "    Ask what the assistant should be called.",
              "  </content>",
              "</bootstrap_file>",
            ].join("\n"),
          };
        },
      },
      cancel: new SessionRunAbortRegistry(),
      modelRunner: runner,
      storage: handle.storage.db,
      securityConfig: DEFAULT_CONFIG.security,
      compaction: DEFAULT_CONFIG.compaction,
    });

    await loop.run({ sessionId: "sess_bootstrap", scenario: "chat" });

    expect(seenSystemPrompts).toHaveLength(1);
    expect(seenSystemPrompts[0]).toContain("## Bootstrap");
    expect(seenSystemPrompts[0]).toContain("clarifying two names");
    expect(seenSystemPrompts[0]).toContain("what you should call the user");
    expect(seenSystemPrompts[0]).toContain("what the user wants to call you");
    expect(seenSystemPrompts[0]).toContain(
      "Do not mention BOOTSTRAP.md, SOUL.md, MEMORY.md, or other internal bootstrap mechanics to the user unless they explicitly ask.",
    );
    expect(seenSystemPrompts[0]).toContain(
      "Do not mix bootstrap questions and the final product-usage handoff into one overloaded reply unless the user explicitly asks for both at once.",
    );
    expect(seenSystemPrompts[0]).toContain(
      "Before deleting BOOTSTRAP.md, send one short proactive handoff message",
    );
    expect(seenSystemPrompts[0]).toContain(
      "this main chat is the Main Agent that coordinates work",
    );
    expect(seenSystemPrompts[0]).toContain("often belong in a SubAgent");
    expect(seenSystemPrompts[0]).toContain(
      "Help me create a SubAgent that fetches the latest financial news every day.",
    );
    expect(seenSystemPrompts[0]).toContain("<bootstrap_file>");
  });

  test("loads bootstrap after memory seeding so first run can bootstrap", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationFixture(handle);

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    const messagesRepo = new MessagesRepo(handle.storage.db);
    handle.storage.sqlite.exec(`
      INSERT INTO agents (id, conversation_id, kind, created_at)
      VALUES ('agent_main', 'conv_1', 'main', '2026-03-22T00:00:00.000Z');
    `);
    sessionsRepo.create({
      id: "sess_bootstrap_first_run",
      conversationId: "conv_1",
      branchId: "branch_1",
      ownerAgentId: "agent_main",
      purpose: "chat",
      createdAt: new Date("2026-03-22T00:00:00.000Z"),
    });
    messagesRepo.append({
      id: "msg_bootstrap_first_run",
      sessionId: "sess_bootstrap_first_run",
      seq: 1,
      role: "user",
      payloadJson: '{"content":"hello"}',
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
    });

    let bootstrapSeeded = false;
    const seenSystemPrompts: string[] = [];
    const runner: AgentModelRunner = {
      async runTurn(input) {
        seenSystemPrompts.push(input.systemPrompt ?? "");
        return makeAssistantResult({
          content: [{ type: "text", text: "hi" }],
        });
      },
    };

    const loop = new AgentLoop({
      sessions: new AgentSessionService(sessionsRepo, messagesRepo),
      messages: messagesRepo,
      models: new ProviderRegistry(createModelConfig()),
      tools: new ToolRegistry(),
      memoryResolver: {
        resolveForRun() {
          bootstrapSeeded = true;
          const entries = [
            {
              layer: "soul" as const,
              path: "/tmp/ws/SOUL.md",
              purpose: "Identity, tone, boundaries, and stable user profile.",
              content: "User prefers concise updates.",
            },
          ];
          return {
            entries,
            warnings: [],
            prompt: buildMemoryCatalogPrompt(entries),
          };
        },
      },
      bootstrapResolver: {
        resolveForRun() {
          if (!bootstrapSeeded) {
            return null;
          }
          return {
            path: "/tmp/ws/BOOTSTRAP.md",
            content: "Ask what to call the user.",
            prompt: [
              "<bootstrap_file>",
              "The file below defines first-run bootstrap instructions for this session.",
              "  <path>/tmp/ws/BOOTSTRAP.md</path>",
              "  <content>",
              "    Ask what to call the user.",
              "  </content>",
              "</bootstrap_file>",
            ].join("\n"),
          };
        },
      },
      cancel: new SessionRunAbortRegistry(),
      modelRunner: runner,
      storage: handle.storage.db,
      securityConfig: DEFAULT_CONFIG.security,
      compaction: DEFAULT_CONFIG.compaction,
    });

    await loop.run({ sessionId: "sess_bootstrap_first_run", scenario: "chat" });

    expect(seenSystemPrompts).toHaveLength(1);
    expect(seenSystemPrompts[0]).toContain("## Bootstrap");
    expect(seenSystemPrompts[0]).toContain(
      "Keep the handoff brief. It should feel like a quick usage tip, not a product manual.",
    );
    expect(seenSystemPrompts[0]).toContain(
      "proactively teach the user the product's real operating shape",
    );
    expect(seenSystemPrompts[0]).toContain("<bootstrap_file>");
  });

  test("passes session purpose into the model runner for session-scoped tool visibility", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationFixture(handle);

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    const messagesRepo = new MessagesRepo(handle.storage.db);
    handle.storage.sqlite.exec(`
      INSERT INTO agents (id, conversation_id, kind, created_at)
      VALUES ('agent_main', 'conv_1', 'main', '2026-03-22T00:00:00.000Z');
    `);
    sessionsRepo.create({
      id: "sess_main",
      conversationId: "conv_1",
      branchId: "branch_1",
      ownerAgentId: "agent_main",
      purpose: "chat",
      createdAt: new Date("2026-03-22T00:00:00.000Z"),
    });
    messagesRepo.append({
      id: "msg_user",
      sessionId: "sess_main",
      seq: 1,
      role: "user",
      payloadJson: '{"content":"create a subagent"}',
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
    });

    const calls: Array<{
      sessionPurpose: string | undefined;
      agentKind: string | null | undefined;
    }> = [];
    const runner: AgentModelRunner = {
      async runTurn(input) {
        calls.push({
          sessionPurpose: input.sessionPurpose,
          agentKind: input.agentKind,
        });
        return makeAssistantResult({
          content: [{ type: "text", text: "ok" }],
        });
      },
    };

    const loop = new AgentLoop({
      sessions: new AgentSessionService(sessionsRepo, messagesRepo),
      messages: messagesRepo,
      models: new ProviderRegistry(createModelConfig()),
      tools: new ToolRegistry(),
      cancel: new SessionRunAbortRegistry(),
      modelRunner: runner,
      storage: handle.storage.db,
      securityConfig: DEFAULT_CONFIG.security,
      compaction: DEFAULT_CONFIG.compaction,
    });

    await loop.run({ sessionId: "sess_main", scenario: "chat" });

    expect(calls).toEqual([{ sessionPurpose: "chat", agentKind: "main" }]);
  });

  test("fails loudly when the configured max turn limit is exhausted", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationFixture(handle);

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    const messagesRepo = new MessagesRepo(handle.storage.db);
    sessionsRepo.create({
      id: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      purpose: "chat",
      createdAt: new Date("2026-03-22T00:00:00.000Z"),
    });
    messagesRepo.append({
      id: "msg_user",
      sessionId: "sess_1",
      seq: 1,
      role: "user",
      payloadJson: '{"content":"keep going"}',
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
    });

    let turn = 0;
    const runner: AgentModelRunner = {
      async runTurn() {
        turn += 1;
        return makeAssistantResult({
          stopReason: "toolUse",
          content: [{ type: "toolCall", id: `tool_${turn}`, name: "probe", arguments: {} }],
        });
      },
    };

    const tools = new ToolRegistry();
    tools.register(
      defineTool({
        name: "probe",
        description: "Returns a trivial result",
        inputSchema: NO_ARGS_TOOL_SCHEMA,
        execute() {
          return textToolResult("ok");
        },
      }),
    );

    const emittedEvents: Array<{ type: string; errorKind?: string; errorMessage?: string }> = [];
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
      runtime: {
        ...DEFAULT_CONFIG.runtime,
        maxTurns: 2,
      },
      emitEvent(event) {
        emittedEvents.push(event);
      },
    });

    await expect(loop.run({ sessionId: "sess_1", scenario: "chat" })).rejects.toThrow(
      "configured max turn limit (2)",
    );

    const rows = messagesRepo.listBySession("sess_1");
    expect(rows).toHaveLength(5);
    expect(rows.map((row) => row.role)).toEqual(["user", "assistant", "tool", "assistant", "tool"]);
    expect(emittedEvents.some((event) => event.type === "run_completed")).toBe(false);
    expect(emittedEvents.at(-1)).toMatchObject({
      type: "run_failed",
      errorKind: "unknown",
      errorMessage: expect.stringContaining("configured max turn limit (2)"),
    });
  });

  test("uses the default max turn limit of 60 when runtime config is omitted", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationFixture(handle);

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    sessionsRepo.create({
      id: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      purpose: "chat",
      createdAt: new Date("2026-03-22T00:00:00.000Z"),
      updatedAt: new Date("2026-03-22T00:00:00.000Z"),
    });

    const messagesRepo = new MessagesRepo(handle.storage.db);
    messagesRepo.append({
      id: "msg_1",
      sessionId: "sess_1",
      seq: 1,
      role: "user",
      payloadJson: JSON.stringify({ content: "keep going" }),
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
    });

    let turn = 0;
    const runner: AgentModelRunner = {
      async runTurn() {
        turn += 1;
        return makeAssistantResult({
          stopReason: "toolUse",
          content: [{ type: "toolCall", id: `tool_${turn}`, name: "probe", arguments: {} }],
        });
      },
    };

    const tools = new ToolRegistry();
    tools.register(
      defineTool({
        name: "probe",
        description: "Returns a trivial result",
        inputSchema: NO_ARGS_TOOL_SCHEMA,
        execute() {
          return textToolResult("ok");
        },
      }),
    );

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
    });

    await expect(loop.run({ sessionId: "sess_1", scenario: "chat" })).rejects.toThrow(
      "configured max turn limit (60)",
    );
    expect(turn).toBe(60);
  });

  test("passes owner agent and workspace cwd into tool execution context", async () => {
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
      payloadJson: '{"content":"inspect tool context"}',
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
    });

    let turnCount = 0;
    const runner: AgentModelRunner = {
      async runTurn() {
        turnCount += 1;
        if (turnCount === 1) {
          return makeAssistantResult({
            content: [{ type: "toolCall", id: "tool_1", name: "inspect_context", arguments: {} }],
            stopReason: "toolUse",
          });
        }

        return makeAssistantResult({
          content: [{ type: "text", text: "done" }],
        });
      },
    };

    const tools = new ToolRegistry();
    tools.register(
      defineTool({
        name: "inspect_context",
        description: "Inspect tool context",
        inputSchema: NO_ARGS_TOOL_SCHEMA,
        execute(context) {
          expect(context.ownerAgentId).toBe("agent_1");
          expect(context.cwd).toBe(POKOCLAW_WORKSPACE_DIR);
          return textToolResult("ok");
        },
      }),
    );

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
    });

    const result = await loop.run({ sessionId: "sess_1", scenario: "chat" });

    expect(result.events.some((event) => event.type === "tool_call_completed")).toBe(true);
    expect(result.events.some((event) => event.type === "tool_call_failed")).toBe(false);
  });

  test("blocks disallowed tools inside approval sessions", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    const messagesRepo = new MessagesRepo(handle.storage.db);
    sessionsRepo.create({
      id: "sess_approval",
      conversationId: "conv_1",
      branchId: "branch_1",
      ownerAgentId: "agent_1",
      purpose: "approval",
      createdAt: new Date("2026-03-22T00:00:00.000Z"),
    });
    messagesRepo.append({
      id: "msg_system",
      sessionId: "sess_approval",
      seq: 1,
      role: "user",
      messageType: "approval_request",
      visibility: "hidden_system",
      payloadJson: '{"content":"review this delegated approval"}',
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
    });

    let turnCount = 0;
    const runner: AgentModelRunner = {
      async runTurn() {
        turnCount += 1;
        if (turnCount === 1) {
          return makeAssistantResult({
            content: [
              { type: "toolCall", id: "tool_1", name: "bash", arguments: { command: "pwd" } },
            ],
            stopReason: "toolUse",
          });
        }

        return makeAssistantResult({
          content: [{ type: "text", text: "done" }],
        });
      },
    };

    const loop = new AgentLoop({
      sessions: new AgentSessionService(sessionsRepo, messagesRepo),
      messages: messagesRepo,
      models: new ProviderRegistry(createModelConfig()),
      tools: new ToolRegistry(),
      cancel: new SessionRunAbortRegistry(),
      modelRunner: runner,
      storage: handle.storage.db,
      securityConfig: DEFAULT_CONFIG.security,
      compaction: DEFAULT_CONFIG.compaction,
    });

    await loop.run({ sessionId: "sess_approval", scenario: "chat" });

    const rows = messagesRepo.listBySession("sess_approval");
    const toolRow = rows.find((row) => row.role === "tool");
    expect(toolRow).toBeDefined();
    const payload = JSON.parse(toolRow?.payloadJson ?? "{}");
    expect(payload.isError).toBe(true);
    expect(payload.details).toMatchObject({
      code: "tool_not_allowed_for_session_purpose",
      toolName: "bash",
      sessionPurpose: "approval",
    });
  });

  test("filters approval-session skills down to built-in entries before prompt injection", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    const messagesRepo = new MessagesRepo(handle.storage.db);
    sessionsRepo.create({
      id: "sess_approval",
      conversationId: "conv_1",
      branchId: "branch_1",
      ownerAgentId: "agent_1",
      purpose: "approval",
      createdAt: new Date("2026-03-22T00:00:00.000Z"),
    });
    messagesRepo.append({
      id: "msg_approval",
      sessionId: "sess_approval",
      seq: 1,
      role: "user",
      messageType: "approval_request",
      visibility: "hidden_system",
      payloadJson: '{"content":"review this delegated approval"}',
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
    });

    const seenSystemPrompts: string[] = [];
    const loop = new AgentLoop({
      sessions: new AgentSessionService(sessionsRepo, messagesRepo),
      messages: messagesRepo,
      models: new ProviderRegistry(createModelConfig()),
      tools: new ToolRegistry(),
      skillsResolver: {
        resolveForRun() {
          const entries = [
            {
              name: "repo-review",
              description: "Review repository-local instructions.",
              skillKey: "repo_agents:repo-review/SKILL.md",
              source: "repo_agents" as const,
              rootDir: "/tmp/repo/.agents/skills",
              skillDir: "/tmp/repo/.agents/skills/repo-review",
              skillFilePath: "/tmp/repo/.agents/skills/repo-review/SKILL.md",
            },
            {
              name: "approval-review",
              description: "Review permission requests safely.",
              skillKey: "builtin:approval-review/SKILL.md",
              source: "builtin" as const,
              rootDir: `${POKOCLAW_REPO_DIR}/skills`,
              skillDir: `${POKOCLAW_REPO_DIR}/skills/approval-review`,
              skillFilePath: `${POKOCLAW_REPO_DIR}/skills/approval-review/SKILL.md`,
            },
          ];

          return {
            entries,
            warnings: [],
            prompt: buildSkillsCatalogPrompt(entries),
          };
        },
      },
      cancel: new SessionRunAbortRegistry(),
      modelRunner: {
        async runTurn(input) {
          seenSystemPrompts.push(input.systemPrompt ?? "");
          return makeAssistantResult({
            content: [{ type: "text", text: "reviewed" }],
          });
        },
      },
      storage: handle.storage.db,
      securityConfig: DEFAULT_CONFIG.security,
      compaction: DEFAULT_CONFIG.compaction,
    });

    await loop.run({ sessionId: "sess_approval", scenario: "chat" });

    expect(seenSystemPrompts).toHaveLength(1);
    expect(seenSystemPrompts[0]).toContain("## Skills");
    expect(seenSystemPrompts[0]).toContain("<name>approval-review</name>");
    expect(seenSystemPrompts[0]).not.toContain("<name>repo-review</name>");
  });

  test("filters non-readable skills out of the injected catalog for task sessions", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    const messagesRepo = new MessagesRepo(handle.storage.db);
    handle.storage.sqlite.exec(`
      UPDATE agents
      SET workdir = '/tmp/external-repo/packages/web'
      WHERE id = 'agent_1';
    `);
    sessionsRepo.create({
      id: "sess_subagent",
      conversationId: "conv_1",
      branchId: "branch_1",
      ownerAgentId: "agent_1",
      purpose: "chat",
      createdAt: new Date("2026-03-22T00:00:00.000Z"),
    });
    messagesRepo.append({
      id: "msg_user",
      sessionId: "sess_subagent",
      seq: 1,
      role: "user",
      payloadJson: '{"content":"which skills do I have?"}',
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
    });

    const seenSystemPrompts: string[] = [];
    const loop = new AgentLoop({
      sessions: new AgentSessionService(sessionsRepo, messagesRepo),
      messages: messagesRepo,
      models: new ProviderRegistry(createModelConfig()),
      tools: new ToolRegistry(),
      skillsResolver: {
        resolveForRun() {
          const entries = [
            {
              name: "global-review",
              description: "Global skill.",
              skillKey: "global:global-review/SKILL.md",
              source: "global" as const,
              rootDir: POKOCLAW_SKILLS_DIR,
              skillDir: `${POKOCLAW_SKILLS_DIR}/global-review`,
              skillFilePath: `${POKOCLAW_SKILLS_DIR}/global-review/SKILL.md`,
            },
            {
              name: "repo-review",
              description: "Repo-local skill.",
              skillKey: "repo_claude:repo-review/SKILL.md",
              source: "repo_claude" as const,
              rootDir: "/tmp/external-repo/.claude/skills",
              skillDir: "/tmp/external-repo/.claude/skills/repo-review",
              skillFilePath: "/tmp/external-repo/.claude/skills/repo-review/SKILL.md",
            },
            {
              name: "system-observe",
              description: "Builtin skill.",
              skillKey: "builtin:system-observe/SKILL.md",
              source: "builtin" as const,
              rootDir: `${POKOCLAW_REPO_DIR}/skills`,
              skillDir: `${POKOCLAW_REPO_DIR}/skills/system-observe`,
              skillFilePath: `${POKOCLAW_REPO_DIR}/skills/system-observe/SKILL.md`,
            },
          ];

          return {
            entries,
            warnings: [],
            prompt: buildSkillsCatalogPrompt(entries),
          };
        },
      },
      cancel: new SessionRunAbortRegistry(),
      modelRunner: {
        async runTurn(input) {
          seenSystemPrompts.push(input.systemPrompt ?? "");
          return makeAssistantResult({
            content: [{ type: "text", text: "done" }],
          });
        },
      },
      storage: handle.storage.db,
      securityConfig: DEFAULT_CONFIG.security,
      compaction: DEFAULT_CONFIG.compaction,
    });

    await loop.run({ sessionId: "sess_subagent", scenario: "chat" });

    expect(seenSystemPrompts).toHaveLength(1);
    expect(seenSystemPrompts[0]).toContain("<name>global-review</name>");
    expect(seenSystemPrompts[0]).toContain("<name>system-observe</name>");
    expect(seenSystemPrompts[0]).not.toContain("<name>repo-review</name>");
  });

  test("fails early when a task session resolves to a model without tool support", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    const messagesRepo = new MessagesRepo(handle.storage.db);
    sessionsRepo.create({
      id: "sess_task",
      conversationId: "conv_1",
      branchId: "branch_1",
      ownerAgentId: "agent_1",
      purpose: "task",
      createdAt: new Date("2026-03-22T00:00:00.000Z"),
    });
    messagesRepo.append({
      id: "msg_task",
      sessionId: "sess_task",
      seq: 1,
      role: "user",
      messageType: "task_kickoff",
      visibility: "hidden_system",
      payloadJson: '{"content":"do the work"}',
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
    });

    const loop = new AgentLoop({
      sessions: new AgentSessionService(sessionsRepo, messagesRepo),
      messages: messagesRepo,
      models: new ProviderRegistry(createModelConfig({ supportsTools: false })),
      tools: new ToolRegistry(),
      cancel: new SessionRunAbortRegistry(),
      modelRunner: {
        async runTurn() {
          throw new Error("model runner should not be called");
        },
      },
      storage: handle.storage.db,
      securityConfig: DEFAULT_CONFIG.security,
      compaction: DEFAULT_CONFIG.compaction,
    });

    await expect(loop.run({ sessionId: "sess_task", scenario: "task" })).rejects.toThrow(
      'Session purpose "task" requires a tool-capable model',
    );
  });

  test("fails early when an approval session resolves to a model without tool support", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    const messagesRepo = new MessagesRepo(handle.storage.db);
    sessionsRepo.create({
      id: "sess_approval",
      conversationId: "conv_1",
      branchId: "branch_1",
      ownerAgentId: "agent_1",
      purpose: "approval",
      createdAt: new Date("2026-03-22T00:00:00.000Z"),
    });
    messagesRepo.append({
      id: "msg_approval",
      sessionId: "sess_approval",
      seq: 1,
      role: "user",
      messageType: "approval_request",
      visibility: "hidden_system",
      payloadJson: '{"content":"review approval"}',
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
    });

    const loop = new AgentLoop({
      sessions: new AgentSessionService(sessionsRepo, messagesRepo),
      messages: messagesRepo,
      models: new ProviderRegistry(createModelConfig({ supportsTools: false })),
      tools: new ToolRegistry(),
      cancel: new SessionRunAbortRegistry(),
      modelRunner: {
        async runTurn() {
          throw new Error("model runner should not be called");
        },
      },
      storage: handle.storage.db,
      securityConfig: DEFAULT_CONFIG.security,
      compaction: DEFAULT_CONFIG.compaction,
    });

    await expect(loop.run({ sessionId: "sess_approval", scenario: "chat" })).rejects.toThrow(
      'Session purpose "approval" requires a tool-capable model',
    );
  });

  test("continues after bash tool calls and persists tool results", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationFixture(handle);

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    const messagesRepo = new MessagesRepo(handle.storage.db);
    sessionsRepo.create({
      id: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      purpose: "chat",
      createdAt: new Date("2026-03-22T00:00:00.000Z"),
    });
    messagesRepo.append({
      id: "msg_user",
      sessionId: "sess_1",
      seq: 1,
      role: "user",
      payloadJson: '{"content":"run ls on the current directory"}',
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
    });

    let callCount = 0;
    const runner: AgentModelRunner = {
      async runTurn() {
        callCount += 1;
        if (callCount === 1) {
          return makeAssistantResult({
            stopReason: "toolUse",
            content: [
              { type: "text", text: "I will inspect the directory." },
              {
                type: "toolCall",
                id: "tool_1",
                name: "bash",
                arguments: {
                  command: "ls -1",
                  workdir: "/workspace",
                  timeoutMs: 10_000,
                },
              },
            ],
          });
        }

        return makeAssistantResult({
          content: [{ type: "text", text: "I found the directory entries." }],
        });
      },
    };

    const tools = new ToolRegistry();
    tools.register(
      defineTool({
        name: "bash",
        description: "Run a shell command",
        inputSchema: TEST_BASH_TOOL_SCHEMA,
        execute(_context, args) {
          return textToolResult("README.md\nsrc\ntests", {
            command: args.command,
            workdir: args.workdir ?? null,
            timeoutMs: args.timeoutMs ?? null,
            exitCode: 0,
          });
        },
      }),
    );

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
    });

    const result = await loop.run({ sessionId: "sess_1", scenario: "chat" });

    const rows = messagesRepo.listBySession("sess_1");
    expect(rows).toHaveLength(4);
    expect(JSON.parse(rows[1]?.payloadJson ?? "{}")).toEqual({
      content: [
        { type: "text", text: "I will inspect the directory." },
        {
          type: "toolCall",
          id: "tool_1",
          name: "bash",
          arguments: {
            command: "ls -1",
            workdir: "/workspace",
            timeoutMs: 10_000,
          },
        },
      ],
    });
    expect(rows[1]?.stopReason).toBe("toolUse");
    expect(JSON.parse(rows[2]?.payloadJson ?? "{}")).toEqual({
      toolCallId: "tool_1",
      toolName: "bash",
      content: [{ type: "text", text: "README.md\nsrc\ntests" }],
      isError: false,
      details: {
        command: "ls -1",
        workdir: "/workspace",
        timeoutMs: 10_000,
        exitCode: 0,
      },
    });
    expect(JSON.parse(rows[3]?.payloadJson ?? "{}")).toEqual({
      content: [{ type: "text", text: "I found the directory entries." }],
    });
    expect(result.toolExecutions).toBe(1);
    expect(result.events.map((event) => event.type)).toEqual([
      "run_started",
      "turn_started",
      "assistant_message_started",
      "assistant_message_delta",
      "assistant_message_completed",
      "tool_call_started",
      "tool_call_completed",
      "turn_completed",
      "turn_started",
      "assistant_message_started",
      "assistant_message_delta",
      "assistant_message_completed",
      "turn_completed",
      "run_completed",
    ]);
  });

  test("emits streamed assistant deltas without falling back to a single full-text delta", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationFixture(handle);

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    const messagesRepo = new MessagesRepo(handle.storage.db);
    sessionsRepo.create({
      id: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      purpose: "chat",
      createdAt: new Date("2026-03-22T00:00:00.000Z"),
    });
    messagesRepo.append({
      id: "msg_user",
      sessionId: "sess_1",
      seq: 1,
      role: "user",
      payloadJson: '{"content":"hello"}',
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
    });

    const runner: AgentModelRunner = {
      async runTurn(input) {
        input.onTextDelta?.({
          delta: "hello ",
          accumulatedText: "hello ",
        });
        input.onTextDelta?.({
          delta: "world",
          accumulatedText: "hello world",
        });

        return makeAssistantResult({
          content: [{ type: "text", text: "hello world" }],
        });
      },
    };

    const loop = new AgentLoop({
      sessions: new AgentSessionService(sessionsRepo, messagesRepo),
      messages: messagesRepo,
      models: new ProviderRegistry(createModelConfig()),
      tools: new ToolRegistry(),
      cancel: new SessionRunAbortRegistry(),
      modelRunner: runner,
      storage: handle.storage.db,
      securityConfig: DEFAULT_CONFIG.security,
      compaction: DEFAULT_CONFIG.compaction,
    });

    const result = await loop.run({ sessionId: "sess_1", scenario: "chat" });

    const deltaEvents = result.events.filter((event) => event.type === "assistant_message_delta");
    expect(deltaEvents).toHaveLength(2);
    expect(deltaEvents).toMatchObject([
      {
        type: "assistant_message_delta",
        delta: "hello ",
        accumulatedText: "hello ",
      },
      {
        type: "assistant_message_delta",
        delta: "world",
        accumulatedText: "hello world",
      },
    ]);
  });

  test("updates runtime control observability across streaming, tool execution, and completion", async () => {
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
      payloadJson: '{"content":"hello"}',
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
    });

    const tools = new ToolRegistry();
    tools.register(
      defineTool({
        name: "echo_tool",
        description: "Echoes its text input.",
        inputSchema: Type.Object({ text: Type.String() }, { additionalProperties: false }),
        execute(_context, args) {
          return textToolResult(args.text);
        },
      }),
    );

    const runner: AgentModelRunner = {
      async runTurn(input) {
        if (input.messages.some((message) => message.role === "tool")) {
          input.onTextDelta?.({
            delta: "done",
            accumulatedText: "done",
          });
          return makeAssistantResult({
            content: [{ type: "text", text: "done" }],
          });
        }

        input.onTextDelta?.({
          delta: "checking",
          accumulatedText: "checking",
        });
        return makeAssistantResult({
          stopReason: "toolUse",
          content: [
            { type: "text", text: "checking" },
            {
              type: "toolCall",
              id: "tool_1",
              name: "echo_tool",
              arguments: { text: "ok" },
            },
          ],
        });
      },
    };

    const control = new RuntimeControlService(new SessionRunAbortRegistry());
    const markLlmRequestStarted = vi.spyOn(control, "markLlmRequestStarted");
    const recordStreamDelta = vi.spyOn(control, "recordStreamDelta");
    const setFinalOutputTokens = vi.spyOn(control, "setFinalOutputTokens");
    const markToolStarted = vi.spyOn(control, "markToolStarted");
    const markToolFinished = vi.spyOn(control, "markToolFinished");
    const markCompleted = vi.spyOn(control, "markCompleted");

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
      control,
    });

    await loop.run({ sessionId: "sess_1", scenario: "chat" });

    expect(markLlmRequestStarted).toHaveBeenCalledTimes(2);
    expect(recordStreamDelta).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "text", deltaText: "checking" }),
    );
    expect(recordStreamDelta).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "text", deltaText: "done" }),
    );
    expect(setFinalOutputTokens).toHaveBeenCalledWith(expect.objectContaining({ outputTokens: 5 }));
    expect(markToolStarted).toHaveBeenCalledWith(
      expect.objectContaining({ toolCallId: "tool_1", toolName: "echo_tool" }),
    );
    expect(markToolFinished).toHaveBeenCalledWith(
      expect.objectContaining({ toolCallId: "tool_1" }),
    );
    expect(markCompleted).toHaveBeenCalledTimes(1);

    const completedRunId = markCompleted.mock.calls[0]?.[0]?.runId;
    expect(completedRunId).toBeTruthy();
    expect(control.getRunObservability(completedRunId as string)).toMatchObject({
      runId: completedRunId,
      phase: "completed",
      runStartedAt: expect.any(String),
      latestRequest: expect.objectContaining({
        sequence: 2,
        status: "finished",
        startedAt: expect.any(String),
        ttftMs: 0,
      }),
      responseSummary: {
        requestCount: 2,
        respondedRequestCount: 2,
        hasAnyResponse: true,
        firstResponseAt: expect.any(String),
        lastResponseAt: expect.any(String),
        lastRespondedRequestSequence: 2,
        lastRespondedRequestTtftMs: 0,
      },
    });
    expect(control.listActiveRunObservability()).toEqual([]);
  });

  test("emits streamed reasoning deltas and does not duplicate final reasoning text", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationFixture(handle);

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    const messagesRepo = new MessagesRepo(handle.storage.db);
    sessionsRepo.create({
      id: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      purpose: "chat",
      createdAt: new Date("2026-03-22T00:00:00.000Z"),
    });
    messagesRepo.append({
      id: "msg_user",
      sessionId: "sess_1",
      seq: 1,
      role: "user",
      payloadJson: '{"content":"hello"}',
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
    });

    const runner: AgentModelRunner = {
      async runTurn(input) {
        input.onThinkingDelta?.({
          delta: "Let me think...",
        });
        input.onTextDelta?.({
          delta: "hello",
          accumulatedText: "hello",
        });

        return makeAssistantResult({
          content: [
            { type: "thinking", thinking: "Let me think..." },
            { type: "text", text: "hello" },
          ],
        });
      },
    };

    const loop = new AgentLoop({
      sessions: new AgentSessionService(sessionsRepo, messagesRepo),
      messages: messagesRepo,
      models: new ProviderRegistry(createModelConfig()),
      tools: new ToolRegistry(),
      cancel: new SessionRunAbortRegistry(),
      modelRunner: runner,
      storage: handle.storage.db,
      securityConfig: DEFAULT_CONFIG.security,
      compaction: DEFAULT_CONFIG.compaction,
    });

    const result = await loop.run({ sessionId: "sess_1", scenario: "chat" });

    expect(
      result.events.filter((event) => event.type === "assistant_reasoning_delta"),
    ).toMatchObject([
      {
        type: "assistant_reasoning_delta",
        delta: "Let me think...",
      },
    ]);

    expect(
      result.events.find((event) => event.type === "assistant_message_completed"),
    ).toMatchObject({
      type: "assistant_message_completed",
      reasoningText: null,
      text: "hello",
    });
  });

  test("propagates cancellation through the active session run", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationFixture(handle);

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    const messagesRepo = new MessagesRepo(handle.storage.db);
    sessionsRepo.create({
      id: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      purpose: "chat",
      createdAt: new Date("2026-03-22T00:00:00.000Z"),
    });
    messagesRepo.append({
      id: "msg_user",
      sessionId: "sess_1",
      seq: 1,
      role: "user",
      payloadJson: '{"content":"run slow tool"}',
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
    });

    const cancel = new SessionRunAbortRegistry();
    const runner: AgentModelRunner = {
      async runTurn() {
        return makeAssistantResult({
          stopReason: "toolUse",
          content: [
            { type: "text", text: "Working on it." },
            { type: "toolCall", id: "tool_1", name: "slow", arguments: {} },
          ],
        });
      },
    };

    const tools = new ToolRegistry();
    tools.register(
      defineTool({
        name: "slow",
        description: "Slow tool",
        inputSchema: NO_ARGS_TOOL_SCHEMA,
        async execute(context) {
          await delay(1000, undefined, { signal: context.abortSignal });
          return textToolResult("done");
        },
      }),
    );

    const emittedEvents: Array<{ type: string; reason?: string }> = [];
    const loop = new AgentLoop({
      sessions: new AgentSessionService(sessionsRepo, messagesRepo),
      messages: messagesRepo,
      models: new ProviderRegistry(createModelConfig()),
      tools,
      cancel,
      modelRunner: runner,
      storage: handle.storage.db,
      securityConfig: DEFAULT_CONFIG.security,
      compaction: DEFAULT_CONFIG.compaction,
      emitEvent(event) {
        emittedEvents.push(event);
      },
    });

    const runPromise = loop.run({ sessionId: "sess_1", scenario: "chat" });
    await delay(20);
    expect(cancel.cancel("sess_1", "stop requested")).toBe(true);

    await expect(runPromise).rejects.toThrow();
    expect(cancel.isActive("sess_1")).toBe(false);
    expect(emittedEvents.at(-1)).toMatchObject({
      type: "run_cancelled",
      reason: "stop requested",
    });
    expect(emittedEvents.some((event) => event.type === "run_failed")).toBe(false);
  });

  test("request_permissions pauses for approval, retries the blocked tool, and inserts queued steer input", async () => {
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
      payloadJson: '{"content":"update the file"}',
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
    });

    let modelTurnCount = 0;
    let toolExecuteCount = 0;
    let secondTurnLastUserContent: string | null = null;
    const runner: AgentModelRunner = {
      async runTurn({ messages }) {
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

        secondTurnLastUserContent =
          JSON.parse(messages.at(-1)?.payloadJson ?? "{}").content ?? null;
        return makeAssistantResult({
          content: [{ type: "text", text: "done" }],
        });
      },
    };

    const tools = new ToolRegistry();
    tools.register(
      defineTool({
        name: "gated",
        description: "Needs approval first",
        inputSchema: NO_ARGS_TOOL_SCHEMA,
        execute() {
          toolExecuteCount += 1;
          if (toolExecuteCount === 1) {
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
    );
    tools.register(createRequestPermissionsTool());

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

    expect(loop.enqueueSteerInput({ sessionId: "sess_1", content: "Please keep it short." })).toBe(
      true,
    );
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

    expect(toolExecuteCount).toBe(2);
    expect(secondTurnLastUserContent).toBe("Please keep it short.");
    expect(result.events.some((event) => event.type === "approval_requested")).toBe(true);
    expect(
      result.events.some(
        (event) => event.type === "approval_resolved" && event.decision === "approve",
      ),
    ).toBe(true);
    expect(sessionsRepo.getById("sess_1")?.status).toBe("active");

    const rows = messagesRepo.listBySession("sess_1");
    expect(rows).toHaveLength(7);
    expect(JSON.parse(rows[2]?.payloadJson ?? "{}")).toMatchObject({
      toolCallId: "tool_1",
      toolName: "gated",
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
          name: "request_permissions",
        },
      ],
    });
    expect(JSON.parse(rows[4]?.payloadJson ?? "{}")).toMatchObject({
      toolCallId: "tool_2",
      toolName: "request_permissions",
      isError: false,
    });
    expect(JSON.parse(rows[5]?.payloadJson ?? "{}")).toEqual({
      content: "Please keep it short.",
    });
  });

  test("approval_requested events carry the full structured permission request", async () => {
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
      payloadJson: '{"content":"request the extra access"}',
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
                name: "request_permissions",
                arguments: {
                  entries: [
                    {
                      resource: "filesystem",
                      path: "/tmp/requested-read.txt",
                      scope: "exact",
                      access: "read",
                    },
                    {
                      resource: "filesystem",
                      path: "/tmp/requested-write.txt",
                      scope: "exact",
                      access: "write",
                    },
                  ],
                  justification: "Need to inspect one file and update another.",
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

    const tools = new ToolRegistry([createRequestPermissionsTool()]);
    const emittedEvents: Array<{
      type: string;
      approvalId?: string;
      decision?: string;
      title?: string;
      request?: {
        scopes: Array<
          | { kind: "fs.read"; path: string }
          | { kind: "fs.write"; path: string }
          | { kind: "db.read"; database: "system" }
          | { kind: "db.write"; database: "system" }
          | { kind: "bash.full_access"; prefix: string[] }
        >;
      };
    }> = [];
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

    expect(emittedEvents.find((event) => event.type === "approval_requested")?.request).toEqual({
      scopes: [
        { kind: "fs.read", path: "/tmp/requested-read.txt" },
        { kind: "fs.write", path: "/tmp/requested-write.txt" },
      ],
    });

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
    expect(
      result.events.some(
        (event) => event.type === "approval_resolved" && event.decision === "approve",
      ),
    ).toBe(true);
  });

  test("updates runtime observability while a permission approval is pending", async () => {
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
      payloadJson: '{"content":"request the extra access"}',
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
                name: "request_permissions",
                arguments: {
                  entries: [
                    {
                      resource: "filesystem",
                      path: "/tmp/requested-read.txt",
                      scope: "exact",
                      access: "read",
                    },
                  ],
                  justification: "Need to inspect one file.",
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

    const tools = new ToolRegistry([createRequestPermissionsTool()]);
    const control = new RuntimeControlService(new SessionRunAbortRegistry());
    const markWaitingApproval = vi.spyOn(control, "markWaitingApproval");
    const clearWaitingApproval = vi.spyOn(control, "clearWaitingApproval");
    const recordStreamDelta = vi.spyOn(control, "recordStreamDelta");
    const setFinalOutputTokens = vi.spyOn(control, "setFinalOutputTokens");
    const emittedEvents: Array<{ type: string; approvalId?: string }> = [];

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
      control,
      emitEvent(event) {
        emittedEvents.push(event);
      },
    });

    const runPromise = loop.run({ sessionId: "sess_1", scenario: "chat" });
    const approvalId = await waitForApprovalRequested(emittedEvents);

    let waitingRunId: string | null = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      waitingRunId = markWaitingApproval.mock.calls[0]?.[0]?.runId ?? null;
      if (waitingRunId != null) {
        break;
      }
      await delay(5);
    }
    expect(waitingRunId).toBeTruthy();
    expect(markWaitingApproval).toHaveBeenCalledWith({
      runId: waitingRunId,
      approvalId: String(approvalId),
    });
    expect(control.getRunObservability(waitingRunId as string)).toMatchObject({
      runId: waitingRunId,
      phase: "waiting_approval",
      waitingApprovalId: String(approvalId),
      latestRequest: {
        status: "finished",
      },
    });
    expect(recordStreamDelta).not.toHaveBeenCalled();
    expect(setFinalOutputTokens).toHaveBeenCalledWith(expect.objectContaining({ outputTokens: 5 }));

    expect(
      loop.submitApprovalResponse({
        approvalId: Number(approvalId),
        decision: "approve",
        actor: "user",
        rawInput: "approve",
        grantedBy: "user",
        expiresAt: null,
      }),
    ).toBe(true);

    await runPromise;
    expect(clearWaitingApproval).toHaveBeenCalledWith(waitingRunId);
    expect(control.getRunObservability(waitingRunId as string)).toMatchObject({
      runId: waitingRunId,
      phase: "completed",
      waitingApprovalId: null,
      latestRequest: {
        status: "finished",
      },
    });
  });

  test("writes an error request_permissions tool result when approval is denied", async () => {
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
      payloadJson: '{"content":"try the protected action"}',
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
    });

    let modelTurnCount = 0;
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
                      access: "read",
                    },
                  ],
                  justification: "Need to read the protected file.",
                  retryToolCallId: "tool_1",
                },
              },
            ],
          });
        }

        return makeAssistantResult({
          content: [{ type: "text", text: "The user denied the request." }],
        });
      },
    };

    const tools = new ToolRegistry();
    tools.register(
      defineTool({
        name: "gated",
        description: "Needs approval first",
        inputSchema: NO_ARGS_TOOL_SCHEMA,
        execute() {
          throw toolRecoverableError("Read access is missing for the protected file.", {
            code: "permission_denied",
            requestable: true,
            failedToolCallId: "tool_1",
            summary: "Read access is missing for the protected file.",
            entries: [
              {
                resource: "filesystem",
                path: LOOP_PROTECTED_FILE,
                scope: "exact",
                access: "read",
              },
            ],
          });
        },
      }),
    );
    tools.register(createRequestPermissionsTool());

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
        decision: "deny",
        actor: "user",
        rawInput: "deny",
        reasonText: "The user denied this permission request.",
      }),
    ).toBe(true);

    const result = await runPromise;

    expect(
      result.events.some(
        (event) => event.type === "approval_resolved" && event.decision === "deny",
      ),
    ).toBe(true);
    expect(result.events.some((event) => event.type === "tool_call_failed")).toBe(true);

    const rows = messagesRepo.listBySession("sess_1");
    expect(rows).toHaveLength(6);
    expect(JSON.parse(rows[2]?.payloadJson ?? "{}")).toMatchObject({
      toolCallId: "tool_1",
      toolName: "gated",
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
          name: "request_permissions",
        },
      ],
    });
    expect(JSON.parse(rows[4]?.payloadJson ?? "{}")).toMatchObject({
      toolCallId: "tool_2",
      toolName: "request_permissions",
      isError: true,
      content: [
        {
          type: "text",
          text: expect.stringContaining("<permission_request_result>"),
        },
      ],
    });
  });

  test("routes task-session approval requests to the main agent target", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    const messagesRepo = new MessagesRepo(handle.storage.db);
    const approvalsRepo = new ApprovalsRepo(handle.storage.db);
    sessionsRepo.create({
      id: "sess_task",
      conversationId: "conv_1",
      branchId: "branch_1",
      ownerAgentId: "agent_1",
      purpose: "task",
      createdAt: new Date("2026-03-22T00:00:00.000Z"),
    });
    messagesRepo.append({
      id: "msg_user",
      sessionId: "sess_task",
      seq: 1,
      role: "user",
      payloadJson: '{"content":"perform the task"}',
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
                id: "tool_task_perm",
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
                },
              },
            ],
          });
        }

        return makeAssistantResult({
          content: [{ type: "text", text: "approved" }],
        });
      },
    };

    const tools = new ToolRegistry();
    tools.register(createRequestPermissionsTool());

    const emittedEvents: Array<{
      type: string;
      approvalId?: string;
      approvalTarget?: "user" | "main_agent";
    }> = [];
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

    const runPromise = loop.run({ sessionId: "sess_task", scenario: "task" });
    const approvalId = Number(await waitForApprovalRequested(emittedEvents));
    const approvalRecord = approvalsRepo.getById(approvalId);

    expect(approvalRecord?.approvalTarget).toBe("main_agent");
    expect(emittedEvents.find((event) => event.type === "approval_requested")?.approvalTarget).toBe(
      "main_agent",
    );

    expect(
      loop.submitApprovalResponse({
        approvalId,
        decision: "approve",
        actor: "main_agent",
        rawInput: "approve",
        grantedBy: "main_agent",
      }),
    ).toBe(true);

    await runPromise;
  });

  test("queues steer input during a streaming text turn and handles it in the next turn", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationFixture(handle);

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    const messagesRepo = new MessagesRepo(handle.storage.db);
    sessionsRepo.create({
      id: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      purpose: "chat",
      createdAt: new Date("2026-03-22T00:00:00.000Z"),
    });
    messagesRepo.append({
      id: "msg_user",
      sessionId: "sess_1",
      seq: 1,
      role: "user",
      payloadJson: '{"content":"start"}',
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
    });

    let turnCount = 0;
    let secondTurnLastUserContent: string | null = null;
    const runner: AgentModelRunner = {
      async runTurn({ onTextDelta, messages }) {
        turnCount += 1;
        if (turnCount === 1) {
          onTextDelta?.({
            delta: "Working",
            accumulatedText: "Working",
          });
          await delay(25);
          return makeAssistantResult({
            content: [{ type: "text", text: "Working" }],
          });
        }

        secondTurnLastUserContent =
          JSON.parse(messages.at(-1)?.payloadJson ?? "{}").content ?? null;
        return makeAssistantResult({
          content: [{ type: "text", text: "Done after steer" }],
        });
      },
    };

    const loop = new AgentLoop({
      sessions: new AgentSessionService(sessionsRepo, messagesRepo),
      messages: messagesRepo,
      models: new ProviderRegistry(createModelConfig()),
      tools: new ToolRegistry(),
      cancel: new SessionRunAbortRegistry(),
      modelRunner: runner,
      storage: handle.storage.db,
      securityConfig: DEFAULT_CONFIG.security,
      compaction: DEFAULT_CONFIG.compaction,
    });

    const runPromise = loop.run({ sessionId: "sess_1", scenario: "chat" });
    await delay(5);
    expect(
      loop.enqueueSteerInput({
        sessionId: "sess_1",
        content: "Use a short answer.",
        messageType: "approval_request",
        visibility: "hidden_system",
      }),
    ).toBe(true);

    const result = await runPromise;

    expect(turnCount).toBe(2);
    expect(secondTurnLastUserContent).toBe("Use a short answer.");
    const rows = messagesRepo.listBySession("sess_1");
    expect(rows).toHaveLength(4);
    expect(JSON.parse(rows[2]?.payloadJson ?? "{}")).toEqual({
      content: "Use a short answer.",
    });
    expect(rows[2]?.messageType).toBe("approval_request");
    expect(rows[2]?.visibility).toBe("hidden_system");
    expect(result.events.filter((event) => event.type === "turn_completed")).toHaveLength(2);
  });

  test("waits until the current assistant tool batch finishes before inserting steer input", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationFixture(handle);

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    const messagesRepo = new MessagesRepo(handle.storage.db);
    sessionsRepo.create({
      id: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      purpose: "chat",
      createdAt: new Date("2026-03-22T00:00:00.000Z"),
    });
    messagesRepo.append({
      id: "msg_user",
      sessionId: "sess_1",
      seq: 1,
      role: "user",
      payloadJson: '{"content":"do two tool steps"}',
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
    });

    let turnCount = 0;
    let secondTurnLastUserContent: string | null = null;
    let toolCallsSeen = 0;
    const runner: AgentModelRunner = {
      async runTurn({ messages }) {
        turnCount += 1;
        if (turnCount === 1) {
          return makeAssistantResult({
            stopReason: "toolUse",
            content: [
              { type: "toolCall", id: "tool_1", name: "step", arguments: { step: 1 } },
              { type: "toolCall", id: "tool_2", name: "step", arguments: { step: 2 } },
            ],
          });
        }

        secondTurnLastUserContent =
          JSON.parse(messages.at(-1)?.payloadJson ?? "{}").content ?? null;
        return makeAssistantResult({
          content: [{ type: "text", text: "Handled after both tools." }],
        });
      },
    };

    const tools = new ToolRegistry();
    tools.register(
      defineTool({
        name: "step",
        description: "Step tool",
        inputSchema: Type.Object(
          {
            step: Type.Integer(),
          },
          { additionalProperties: false },
        ),
        async execute(_context, args) {
          toolCallsSeen += 1;
          if (args.step === 1) {
            expect(
              loop.enqueueSteerInput({ sessionId: "sess_1", content: "Actually summarize it." }),
            ).toBe(true);
          }
          await delay(5);
          return textToolResult(`step ${args.step} done`);
        },
      }),
    );

    let loop: AgentLoop;
    loop = new AgentLoop({
      sessions: new AgentSessionService(sessionsRepo, messagesRepo),
      messages: messagesRepo,
      models: new ProviderRegistry(createModelConfig()),
      tools,
      cancel: new SessionRunAbortRegistry(),
      modelRunner: runner,
      storage: handle.storage.db,
      securityConfig: DEFAULT_CONFIG.security,
      compaction: DEFAULT_CONFIG.compaction,
    });

    await loop.run({ sessionId: "sess_1", scenario: "chat" });

    expect(toolCallsSeen).toBe(2);
    expect(turnCount).toBe(2);
    expect(secondTurnLastUserContent).toBe("Actually summarize it.");

    const rows = messagesRepo.listBySession("sess_1");
    expect(rows).toHaveLength(6);
    expect(JSON.parse(rows[2]?.payloadJson ?? "{}")).toMatchObject({
      toolCallId: "tool_1",
      toolName: "step",
    });
    expect(JSON.parse(rows[3]?.payloadJson ?? "{}")).toMatchObject({
      toolCallId: "tool_2",
      toolName: "step",
    });
    expect(JSON.parse(rows[4]?.payloadJson ?? "{}")).toEqual({
      content: "Actually summarize it.",
    });
  });

  test("returns recoverable tool failures to the model as error tool results", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationFixture(handle);

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    const messagesRepo = new MessagesRepo(handle.storage.db);
    sessionsRepo.create({
      id: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      purpose: "chat",
      createdAt: new Date("2026-03-22T00:00:00.000Z"),
    });
    messagesRepo.append({
      id: "msg_user",
      sessionId: "sess_1",
      seq: 1,
      role: "user",
      payloadJson: '{"content":"run cat on a missing file"}',
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
    });

    let callCount = 0;
    const runner: AgentModelRunner = {
      async runTurn() {
        callCount += 1;
        if (callCount === 1) {
          return makeAssistantResult({
            stopReason: "toolUse",
            content: [
              {
                type: "toolCall",
                id: "tool_1",
                name: "bash",
                arguments: { command: "cat missing.txt" },
              },
            ],
          });
        }

        return makeAssistantResult({
          content: [{ type: "text", text: "The file was missing, so the command failed." }],
        });
      },
    };

    const tools = new ToolRegistry();
    tools.register(
      defineTool({
        name: "bash",
        description: "Run a shell command",
        inputSchema: TEST_BASH_TOOL_SCHEMA,
        execute() {
          throw toolRecoverableError("bash exited with code 1: cat: missing.txt: No such file");
        },
      }),
    );

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
    });

    const result = await loop.run({ sessionId: "sess_1", scenario: "chat" });

    const rows = messagesRepo.listBySession("sess_1");
    expect(rows).toHaveLength(4);
    expect(JSON.parse(rows[2]?.payloadJson ?? "{}")).toEqual({
      toolCallId: "tool_1",
      toolName: "bash",
      content: [{ type: "text", text: "bash exited with code 1: cat: missing.txt: No such file" }],
      isError: true,
    });
    expect(result.events.some((event) => event.type === "tool_call_failed")).toBe(true);
    expect(result.events.at(-1)?.type).toBe("run_completed");
  });

  test("returns invalid schedule_task time values to the model as recoverable error tool results", async () => {
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
      payloadJson: '{"content":"schedule a one-time reminder"}',
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
    });

    let callCount = 0;
    const runner: AgentModelRunner = {
      async runTurn() {
        callCount += 1;
        if (callCount === 1) {
          return makeAssistantResult({
            stopReason: "toolUse",
            content: [
              {
                type: "toolCall",
                id: "tool_1",
                name: "schedule_task",
                arguments: {
                  action: "create",
                  name: "Broken reminder",
                  scheduleKind: "at",
                  scheduleValue: "sometime later",
                  prompt: "Remind the user to check email.",
                },
              },
            ],
          });
        }

        return makeAssistantResult({
          content: [
            { type: "text", text: "The schedule format was invalid, so I need to correct it." },
          ],
        });
      },
    };

    const tools = new ToolRegistry([createScheduleTaskTool()]);

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
    });

    const result = await loop.run({ sessionId: "sess_1", scenario: "chat" });

    const rows = messagesRepo.listBySession("sess_1");
    expect(rows).toHaveLength(4);
    expect(JSON.parse(rows[2]?.payloadJson ?? "{}")).toMatchObject({
      toolCallId: "tool_1",
      toolName: "schedule_task",
      isError: true,
      content: [
        {
          type: "text",
          text: expect.stringContaining('scheduleKind="at"'),
        },
      ],
      details: expect.objectContaining({
        code: "schedule_task_invalid_schedule_value",
        scheduleKind: "at",
      }),
    });
    expect(result.events.some((event) => event.type === "tool_call_failed")).toBe(true);
    expect(result.events.at(-1)?.type).toBe("run_completed");
  });

  test("treats bash non-zero exits as normal tool results when the tool returns them explicitly", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationFixture(handle);

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    const messagesRepo = new MessagesRepo(handle.storage.db);
    sessionsRepo.create({
      id: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      purpose: "chat",
      createdAt: new Date("2026-03-22T00:00:00.000Z"),
    });
    messagesRepo.append({
      id: "msg_user",
      sessionId: "sess_1",
      seq: 1,
      role: "user",
      payloadJson: '{"content":"try reading a missing file with bash"}',
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
    });

    let callCount = 0;
    const runner: AgentModelRunner = {
      async runTurn() {
        callCount += 1;
        if (callCount === 1) {
          return makeAssistantResult({
            stopReason: "toolUse",
            content: [
              {
                type: "toolCall",
                id: "tool_1",
                name: "bash",
                arguments: { command: "cat missing.txt" },
              },
            ],
          });
        }

        return makeAssistantResult({
          content: [{ type: "text", text: "The bash command failed with exit code 1." }],
        });
      },
    };

    const tools = new ToolRegistry();
    tools.register(
      defineTool({
        name: "bash",
        description: "Run a shell command",
        inputSchema: TEST_BASH_TOOL_SCHEMA,
        execute() {
          return textToolResult("cat: missing.txt: No such file or directory", {
            command: "cat missing.txt",
            exitCode: 1,
            stderr: "cat: missing.txt: No such file or directory",
          });
        },
      }),
    );

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
    });

    const result = await loop.run({ sessionId: "sess_1", scenario: "chat" });

    const rows = messagesRepo.listBySession("sess_1");
    expect(rows).toHaveLength(4);
    expect(JSON.parse(rows[2]?.payloadJson ?? "{}")).toEqual({
      toolCallId: "tool_1",
      toolName: "bash",
      content: [{ type: "text", text: "cat: missing.txt: No such file or directory" }],
      isError: false,
      details: {
        command: "cat missing.txt",
        exitCode: 1,
        stderr: "cat: missing.txt: No such file or directory",
      },
    });
    expect(result.events.some((event) => event.type === "tool_call_failed")).toBe(false);
    expect(result.events.at(-1)?.type).toBe("run_completed");
  });

  test("emits structured run_failed events for normalized llm errors", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationFixture(handle);

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    const messagesRepo = new MessagesRepo(handle.storage.db);
    sessionsRepo.create({
      id: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      purpose: "chat",
      createdAt: new Date("2026-03-22T00:00:00.000Z"),
    });
    messagesRepo.append({
      id: "msg_user",
      sessionId: "sess_1",
      seq: 1,
      role: "user",
      payloadJson: '{"content":"hello"}',
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
    });

    const runner: AgentModelRunner = {
      async runTurn() {
        throw new AgentLlmError({
          kind: "rate_limit",
          message: "API rate limit reached",
          retryable: true,
          provider: "anthropic_main",
          model: "anthropic_main/claude-sonnet-4-5",
        });
      },
    };

    const emittedEvents: Array<{ type: string; errorKind?: string; retryable?: boolean }> = [];
    const loop = new AgentLoop({
      sessions: new AgentSessionService(sessionsRepo, messagesRepo),
      messages: messagesRepo,
      models: new ProviderRegistry(createModelConfig()),
      tools: new ToolRegistry(),
      cancel: new SessionRunAbortRegistry(),
      modelRunner: runner,
      storage: handle.storage.db,
      securityConfig: DEFAULT_CONFIG.security,
      compaction: DEFAULT_CONFIG.compaction,
      emitEvent(event) {
        emittedEvents.push(event);
      },
    });

    await expect(loop.run({ sessionId: "sess_1", scenario: "chat" })).rejects.toThrow(
      "API rate limit reached",
    );

    expect(emittedEvents.at(-1)).toMatchObject({
      type: "run_failed",
      errorKind: "rate_limit",
      retryable: true,
    });
  });

  test("retries a retryable llm failure once when no visible output was streamed", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationFixture(handle);

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    const messagesRepo = new MessagesRepo(handle.storage.db);
    sessionsRepo.create({
      id: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      purpose: "chat",
      createdAt: new Date("2026-03-22T00:00:00.000Z"),
    });
    messagesRepo.append({
      id: "msg_user",
      sessionId: "sess_1",
      seq: 1,
      role: "user",
      payloadJson: '{"content":"hello"}',
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
    });

    let runTurnCount = 0;
    const emittedEvents: Array<{ type: string }> = [];
    const runner: AgentModelRunner = {
      async runTurn() {
        runTurnCount += 1;
        if (runTurnCount === 1) {
          throw new AgentLlmError({
            kind: "upstream",
            message: "terminated",
            retryable: true,
            provider: "anthropic_main",
            model: "anthropic_main/claude-sonnet-4-5",
          });
        }

        return makeAssistantResult({
          content: [{ type: "text", text: "recovered reply" }],
        });
      },
    };

    const loop = new AgentLoop({
      sessions: new AgentSessionService(sessionsRepo, messagesRepo),
      messages: messagesRepo,
      models: new ProviderRegistry(createModelConfig()),
      tools: new ToolRegistry(),
      cancel: new SessionRunAbortRegistry(),
      modelRunner: runner,
      storage: handle.storage.db,
      securityConfig: DEFAULT_CONFIG.security,
      compaction: DEFAULT_CONFIG.compaction,
      emitEvent(event) {
        emittedEvents.push(event);
      },
    });

    const result = await loop.run({ sessionId: "sess_1", scenario: "chat" });

    expect(runTurnCount).toBe(2);
    expect(result.events.some((event) => event.type === "run_failed")).toBe(false);
    expect(
      emittedEvents.filter((event) => event.type === "assistant_message_started"),
    ).toHaveLength(2);
    const rows = messagesRepo.listBySession("sess_1");
    expect(rows).toHaveLength(2);
    expect(JSON.parse(rows[1]?.payloadJson ?? "{}")).toEqual({
      content: [{ type: "text", text: "recovered reply" }],
    });
  });

  test("retries a successful empty assistant output once when nothing visible was streamed", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationFixture(handle);

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    const messagesRepo = new MessagesRepo(handle.storage.db);
    sessionsRepo.create({
      id: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      purpose: "chat",
      createdAt: new Date("2026-03-22T00:00:00.000Z"),
    });
    messagesRepo.append({
      id: "msg_user",
      sessionId: "sess_1",
      seq: 1,
      role: "user",
      payloadJson: '{"content":"hello"}',
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
    });

    let runTurnCount = 0;
    const runner: AgentModelRunner = {
      async runTurn() {
        runTurnCount += 1;
        if (runTurnCount === 1) {
          return makeAssistantResult({
            content: [],
          });
        }

        return makeAssistantResult({
          content: [{ type: "text", text: "recovered reply" }],
        });
      },
    };

    const loop = new AgentLoop({
      sessions: new AgentSessionService(sessionsRepo, messagesRepo),
      messages: messagesRepo,
      models: new ProviderRegistry(createModelConfig()),
      tools: new ToolRegistry(),
      cancel: new SessionRunAbortRegistry(),
      modelRunner: runner,
      storage: handle.storage.db,
      securityConfig: DEFAULT_CONFIG.security,
      compaction: DEFAULT_CONFIG.compaction,
    });

    const result = await loop.run({ sessionId: "sess_1", scenario: "chat" });

    expect(runTurnCount).toBe(2);
    expect(
      result.events.filter((event) => event.type === "assistant_message_started"),
    ).toHaveLength(2);
    const rows = messagesRepo.listBySession("sess_1");
    expect(rows).toHaveLength(2);
    expect(JSON.parse(rows[1]?.payloadJson ?? "{}")).toEqual({
      content: [{ type: "text", text: "recovered reply" }],
    });
  });

  test("does not retry a successful empty final response when thinking was already streamed", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationFixture(handle);

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    const messagesRepo = new MessagesRepo(handle.storage.db);
    sessionsRepo.create({
      id: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      purpose: "chat",
      createdAt: new Date("2026-03-22T00:00:00.000Z"),
    });
    messagesRepo.append({
      id: "msg_user",
      sessionId: "sess_1",
      seq: 1,
      role: "user",
      payloadJson: '{"content":"hello"}',
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
    });

    let runTurnCount = 0;
    const runner: AgentModelRunner = {
      async runTurn(input) {
        runTurnCount += 1;
        input.onThinkingDelta?.({
          delta: "Let me think...",
        });
        return makeAssistantResult({
          content: [],
        });
      },
    };

    const loop = new AgentLoop({
      sessions: new AgentSessionService(sessionsRepo, messagesRepo),
      messages: messagesRepo,
      models: new ProviderRegistry(createModelConfig()),
      tools: new ToolRegistry(),
      cancel: new SessionRunAbortRegistry(),
      modelRunner: runner,
      storage: handle.storage.db,
      securityConfig: DEFAULT_CONFIG.security,
      compaction: DEFAULT_CONFIG.compaction,
    });

    const result = await loop.run({ sessionId: "sess_1", scenario: "chat" });

    expect(runTurnCount).toBe(1);
    const rows = messagesRepo.listBySession("sess_1");
    expect(rows).toHaveLength(2);
    expect(JSON.parse(rows[1]?.payloadJson ?? "{}")).toEqual({ content: [] });
    expect(result.events.find((event) => event.type === "assistant_reasoning_delta")).toMatchObject(
      {
        type: "assistant_reasoning_delta",
        delta: "Let me think...",
      },
    );
  });

  test("persists partial streamed output and does not retry when visible output already exists", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationFixture(handle);

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    const messagesRepo = new MessagesRepo(handle.storage.db);
    sessionsRepo.create({
      id: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      purpose: "chat",
      createdAt: new Date("2026-03-22T00:00:00.000Z"),
    });
    messagesRepo.append({
      id: "msg_user",
      sessionId: "sess_1",
      seq: 1,
      role: "user",
      payloadJson: '{"content":"hello"}',
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
    });

    let runTurnCount = 0;
    const emittedEvents: Array<{ type: string }> = [];
    const runner: AgentModelRunner = {
      async runTurn(input) {
        runTurnCount += 1;
        input.onThinkingDelta?.({
          delta: "Let me think...",
        });
        input.onTextDelta?.({
          delta: "partial answer",
          accumulatedText: "partial answer",
        });
        throw new AgentLlmError({
          kind: "upstream",
          message: "terminated",
          retryable: true,
          provider: "anthropic_main",
          model: "anthropic_main/claude-sonnet-4-5",
        });
      },
    };

    const loop = new AgentLoop({
      sessions: new AgentSessionService(sessionsRepo, messagesRepo),
      messages: messagesRepo,
      models: new ProviderRegistry(createModelConfig()),
      tools: new ToolRegistry(),
      cancel: new SessionRunAbortRegistry(),
      modelRunner: runner,
      storage: handle.storage.db,
      securityConfig: DEFAULT_CONFIG.security,
      compaction: DEFAULT_CONFIG.compaction,
      emitEvent(event) {
        emittedEvents.push(event);
      },
    });

    await expect(loop.run({ sessionId: "sess_1", scenario: "chat" })).rejects.toThrow("terminated");

    expect(runTurnCount).toBe(1);
    expect(emittedEvents.map((event) => event.type)).toContain("assistant_message_completed");
    expect(emittedEvents.at(-1)?.type).toBe("run_failed");

    const rows = messagesRepo.listBySession("sess_1");
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      role: "assistant",
      stopReason: "error",
      errorMessage: "terminated",
      provider: "anthropic_main",
      model: "claude-sonnet-4-5-20250929",
      modelApi: "anthropic-messages",
    });
    expect(JSON.parse(rows[1]?.payloadJson ?? "{}")).toEqual({
      content: [
        { type: "thinking", thinking: "Let me think..." },
        { type: "text", text: "partial answer" },
      ],
    });
  });

  test("returns internal tool errors to the model instead of failing the run", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationFixture(handle);

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    const messagesRepo = new MessagesRepo(handle.storage.db);
    sessionsRepo.create({
      id: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      purpose: "chat",
      createdAt: new Date("2026-03-22T00:00:00.000Z"),
    });
    messagesRepo.append({
      id: "msg_user",
      sessionId: "sess_1",
      seq: 1,
      role: "user",
      payloadJson: '{"content":"run fragile tool"}',
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
    });

    const emittedEvents: Array<{ type: string; errorKind?: string }> = [];
    let turns = 0;
    const runner: AgentModelRunner = {
      async runTurn() {
        turns += 1;
        if (turns === 1) {
          return makeAssistantResult({
            stopReason: "toolUse",
            content: [{ type: "toolCall", id: "tool_1", name: "fragile", arguments: {} }],
          });
        }

        return makeAssistantResult({
          content: [{ type: "text", text: "The tool failed internally, so I need another plan." }],
        });
      },
    };

    const tools = new ToolRegistry();
    tools.register(
      defineTool({
        name: "fragile",
        description: "Explodes internally",
        inputSchema: NO_ARGS_TOOL_SCHEMA,
        execute() {
          throw new Error("cannot read properties of undefined");
        },
      }),
    );

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

    const result = await loop.run({ sessionId: "sess_1", scenario: "chat" });

    const rows = messagesRepo.listBySession("sess_1");
    expect(rows).toHaveLength(4);
    expect(JSON.parse(rows[2]?.payloadJson ?? "{}")).toMatchObject({
      toolCallId: "tool_1",
      toolName: "fragile",
      isError: true,
      content: [
        {
          type: "text",
          text: expect.stringContaining("Tool execution failed due to an internal runtime error."),
        },
      ],
    });
    expect(emittedEvents.some((event) => event.type === "tool_call_failed")).toBe(true);
    expect(emittedEvents.find((event) => event.type === "tool_call_failed")).toMatchObject({
      type: "tool_call_failed",
      errorKind: "internal_error",
      errorMessage: "Tool execution failed due to an internal runtime error.",
      rawErrorMessage: "cannot read properties of undefined",
    });
    expect(emittedEvents.at(-1)).toMatchObject({ type: "run_completed" });
    expect(result.events.at(-1)?.type).toBe("run_completed");
  });

  test("returns invalid tool args to the model instead of failing the run", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationFixture(handle);

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    const messagesRepo = new MessagesRepo(handle.storage.db);
    sessionsRepo.create({
      id: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      purpose: "chat",
      createdAt: new Date("2026-03-22T00:00:00.000Z"),
    });
    messagesRepo.append({
      id: "msg_user",
      sessionId: "sess_1",
      seq: 1,
      role: "user",
      payloadJson: '{"content":"run read_file with a bad path first, then recover"}',
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
    });

    let turn = 0;
    const runner: AgentModelRunner = {
      async runTurn(input) {
        turn += 1;
        if (turn === 1) {
          return makeAssistantResult({
            stopReason: "toolUse",
            content: [
              {
                type: "toolCall",
                id: "tool_1",
                name: "read_file",
                arguments: { path: 123 },
              },
            ],
          });
        }

        const toolMessages = input.messages.filter((message) => message.role === "tool");
        expect(toolMessages).toHaveLength(1);
        expect(toolMessages[0]?.payloadJson ?? "").toContain("read_file args are invalid");

        return makeAssistantResult({
          stopReason: "stop",
          content: [{ type: "text", text: "recovered" }],
        });
      },
    };

    const tools = new ToolRegistry();
    tools.register(
      defineTool({
        name: "read_file",
        description: "Reads a file",
        inputSchema: Type.Object(
          {
            path: Type.String(),
          },
          { additionalProperties: false },
        ),
        execute() {
          return textToolResult("ok");
        },
      }),
    );

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
    });

    const result = await loop.run({ sessionId: "sess_1", scenario: "chat" });

    expect(result.events.some((event) => event.type === "run_failed")).toBe(false);

    const rows = messagesRepo.listBySession("sess_1");
    expect(rows).toHaveLength(4);
    expect(rows[2]?.role).toBe("tool");
    expect(rows[2]?.payloadJson ?? "").toContain("read_file args are invalid");
    expect(rows[2]?.payloadJson ?? "").toContain('"isError":true');
    expect(rows[3]?.role).toBe("assistant");
    expect(rows[3]?.payloadJson ?? "").toContain("recovered");
  });

  test("requests compaction when the session context crosses the threshold", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationFixture(handle);

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    const messagesRepo = new MessagesRepo(handle.storage.db);
    sessionsRepo.create({
      id: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      purpose: "chat",
      createdAt: new Date("2026-03-22T00:00:00.000Z"),
    });
    messagesRepo.append({
      id: "msg_user",
      sessionId: "sess_1",
      seq: 1,
      role: "user",
      payloadJson: '{"content":"huge context"}',
      tokenTotal: 150_000,
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
    });

    const runner: AgentModelRunner = {
      async runTurn() {
        return {
          provider: "anthropic_main",
          model: "claude-sonnet-4-5",
          modelApi: "anthropic-messages",
          stopReason: "stop" as const,
          content: [{ type: "text", text: "reply" }],
          usage: {
            input: 150_000,
            output: 1_000,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 151_000,
          },
        };
      },
    };

    const loop = new AgentLoop({
      sessions: new AgentSessionService(sessionsRepo, messagesRepo),
      messages: messagesRepo,
      models: new ProviderRegistry(createModelConfig()),
      tools: new ToolRegistry(),
      cancel: new SessionRunAbortRegistry(),
      modelRunner: runner,
      storage: handle.storage.db,
      securityConfig: DEFAULT_CONFIG.security,
      compaction: DEFAULT_CONFIG.compaction,
    });

    const result = await loop.run({ sessionId: "sess_1", scenario: "chat" });

    expect(result.compaction.shouldCompact).toBe(true);
    expect(result.compaction.reason).toBe("threshold");
    const compactionEvent = result.events.find((event) => event.type === "compaction_requested");
    expect(compactionEvent).toMatchObject({
      type: "compaction_requested",
      sessionId: "sess_1",
      reason: "threshold",
      thresholdTokens: 140_000,
      effectiveWindow: 200_000,
    });
    expect(result.events.at(-1)?.type).toBe("run_completed");
  });

  test("runs threshold compaction asynchronously and persists session compaction state", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationFixture(handle);

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    const messagesRepo = new MessagesRepo(handle.storage.db);
    sessionsRepo.create({
      id: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      purpose: "chat",
      createdAt: new Date("2026-03-22T00:00:00.000Z"),
    });
    messagesRepo.append({
      id: "msg_user_1",
      sessionId: "sess_1",
      seq: 1,
      role: "user",
      payloadJson: '{"content":"older turn"}',
      tokenTotal: 80_000,
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
    });
    messagesRepo.append({
      id: "msg_assistant_1",
      sessionId: "sess_1",
      seq: 2,
      role: "assistant",
      provider: "anthropic_main",
      model: "claude-sonnet-4-5",
      modelApi: "anthropic-messages",
      stopReason: "stop",
      payloadJson: '{"content":[{"type":"text","text":"older reply"}]}',
      usage: {
        input: 80_000,
        output: 1_000,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 81_000,
      },
      createdAt: new Date("2026-03-22T00:00:02.000Z"),
    });
    messagesRepo.append({
      id: "msg_user_2",
      sessionId: "sess_1",
      seq: 3,
      role: "user",
      payloadJson: '{"content":"recent turn"}',
      tokenTotal: 70_000,
      createdAt: new Date("2026-03-22T00:00:03.000Z"),
    });

    const emittedEvents: string[] = [];
    const runner: AgentModelRunner & {
      runCompaction: NonNullable<
        import("@/src/agent/compaction.js").CompactionModelRunner["runCompaction"]
      >;
    } = {
      async runTurn() {
        return {
          provider: "anthropic_main",
          model: "claude-sonnet-4-5",
          modelApi: "anthropic-messages",
          stopReason: "stop" as const,
          content: [{ type: "text", text: "reply" }],
          usage: {
            input: 150_000,
            output: 1_000,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 151_000,
          },
        };
      },
      async runCompaction() {
        return {
          provider: "anthropic_main",
          model: "anthropic_main/claude-sonnet-4-5",
          modelApi: "anthropic-messages",
          text: "compact summary",
          usage: {
            input: 500,
            output: 123,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 623,
          },
        };
      },
    };

    const loop = new AgentLoop({
      sessions: new AgentSessionService(sessionsRepo, messagesRepo),
      messages: messagesRepo,
      models: new ProviderRegistry(createModelConfig()),
      tools: new ToolRegistry(),
      cancel: new SessionRunAbortRegistry(),
      modelRunner: runner,
      storage: handle.storage.db,
      securityConfig: DEFAULT_CONFIG.security,
      compaction: {
        reserveTokens: 60_000,
        keepRecentTokens: 15_000,
        reserveTokensFloor: 60_000,
        recentTurnsPreserve: 1,
      },
      emitEvent(event) {
        emittedEvents.push(event.type);
      },
    });

    await loop.run({ sessionId: "sess_1", scenario: "chat" });
    const session = await waitForSessionCompaction(sessionsRepo, "sess_1");
    expect(session?.compactCursor).toBe(2);
    expect(session?.compactSummary).toBe("compact summary");
    expect(session?.compactSummaryTokenTotal).toBe(123);
    expect(emittedEvents).toContain("compaction_started");
    expect(emittedEvents).toContain("compaction_completed");
  });

  test("recovers from context overflow by compacting and retrying the turn once", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationFixture(handle);

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    const messagesRepo = new MessagesRepo(handle.storage.db);
    sessionsRepo.create({
      id: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      purpose: "chat",
      createdAt: new Date("2026-03-22T00:00:00.000Z"),
    });
    messagesRepo.append({
      id: "msg_user_1",
      sessionId: "sess_1",
      seq: 1,
      role: "user",
      payloadJson: '{"content":"huge request"}',
      tokenTotal: 55_000,
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
    });
    messagesRepo.append({
      id: "msg_assistant_1",
      sessionId: "sess_1",
      seq: 2,
      role: "assistant",
      provider: "anthropic_main",
      model: "claude-sonnet-4-5",
      modelApi: "anthropic-messages",
      stopReason: "stop",
      payloadJson: '{"content":[{"type":"text","text":"partial work"}]}',
      usage: {
        input: 55_000,
        output: 1_000,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 56_000,
      },
      createdAt: new Date("2026-03-22T00:00:02.000Z"),
    });

    let runTurnCount = 0;
    const runner: AgentModelRunner & {
      runCompaction: NonNullable<
        import("@/src/agent/compaction.js").CompactionModelRunner["runCompaction"]
      >;
    } = {
      async runTurn() {
        runTurnCount += 1;
        if (runTurnCount === 1) {
          throw new AgentLlmError({
            kind: "context_overflow",
            message: "context window exceeded",
            retryable: false,
          });
        }

        return makeAssistantResult({
          content: [{ type: "text", text: "recovered reply" }],
        });
      },
      async runCompaction() {
        return {
          provider: "anthropic_main",
          model: "anthropic_main/claude-sonnet-4-5",
          modelApi: "anthropic-messages",
          text: "overflow compact summary",
          usage: {
            input: 500,
            output: 111,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 611,
          },
        };
      },
    };

    const loop = new AgentLoop({
      sessions: new AgentSessionService(sessionsRepo, messagesRepo),
      messages: messagesRepo,
      models: new ProviderRegistry(createModelConfig()),
      tools: new ToolRegistry(),
      cancel: new SessionRunAbortRegistry(),
      modelRunner: runner,
      storage: handle.storage.db,
      securityConfig: DEFAULT_CONFIG.security,
      compaction: DEFAULT_CONFIG.compaction,
    });

    const result = await loop.run({ sessionId: "sess_1", scenario: "chat" });

    const session = sessionsRepo.getById("sess_1");
    expect(runTurnCount).toBe(2);
    expect(session?.compactCursor).toBe(1);
    expect(session?.compactSummary).toContain("overflow compact summary");
    expect(session?.compactSummaryTokenTotal).toBeGreaterThan(0);
    expect(result.compaction.reason).toBe("overflow");
    expect(result.events.some((event) => event.type === "compaction_started")).toBe(true);
    expect(result.events.some((event) => event.type === "compaction_completed")).toBe(true);
    expect(result.events.at(-1)?.type).toBe("run_completed");
  });

  test("recovers from provider-style invalid params context overflow by compacting and retrying", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationFixture(handle);

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    const messagesRepo = new MessagesRepo(handle.storage.db);
    sessionsRepo.create({
      id: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      purpose: "chat",
      createdAt: new Date("2026-03-22T00:00:00.000Z"),
    });
    messagesRepo.append({
      id: "msg_user_1",
      sessionId: "sess_1",
      seq: 1,
      role: "user",
      payloadJson: '{"content":"huge request"}',
      tokenTotal: 55_000,
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
    });
    messagesRepo.append({
      id: "msg_assistant_1",
      sessionId: "sess_1",
      seq: 2,
      role: "assistant",
      provider: "openrouter",
      model: "minimax-m2.7",
      modelApi: "anthropic-messages",
      stopReason: "stop",
      payloadJson: '{"content":[{"type":"text","text":"partial work"}]}',
      usage: {
        input: 55_000,
        output: 1_000,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 56_000,
      },
      createdAt: new Date("2026-03-22T00:00:02.000Z"),
    });

    let runTurnCount = 0;
    const runner: AgentModelRunner & {
      runCompaction: NonNullable<
        import("@/src/agent/compaction.js").CompactionModelRunner["runCompaction"]
      >;
    } = {
      async runTurn() {
        runTurnCount += 1;
        if (runTurnCount === 1) {
          throw normalizeAgentLlmError({
            error: Object.assign(
              new Error(
                '400 {"type":"error","error":{"type":"invalid_request_error","message":"invalid params, context window exceeds limit (2013)"},"request_id":"req_123"}',
              ),
              { status: 400 },
            ),
            provider: "openrouter",
            model: "openrouter/minimax-m2.7",
          });
        }

        return makeAssistantResult({
          content: [{ type: "text", text: "recovered reply" }],
        });
      },
      async runCompaction() {
        return {
          provider: "anthropic_main",
          model: "anthropic_main/claude-sonnet-4-5",
          modelApi: "anthropic-messages",
          text: "overflow compact summary",
          usage: {
            input: 500,
            output: 111,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 611,
          },
        };
      },
    };

    const loop = new AgentLoop({
      sessions: new AgentSessionService(sessionsRepo, messagesRepo),
      messages: messagesRepo,
      models: new ProviderRegistry(createModelConfig()),
      tools: new ToolRegistry(),
      cancel: new SessionRunAbortRegistry(),
      modelRunner: runner,
      storage: handle.storage.db,
      securityConfig: DEFAULT_CONFIG.security,
      compaction: DEFAULT_CONFIG.compaction,
    });

    const result = await loop.run({ sessionId: "sess_1", scenario: "chat" });

    const session = sessionsRepo.getById("sess_1");
    expect(runTurnCount).toBe(2);
    expect(session?.compactCursor).toBe(1);
    expect(session?.compactSummary).toContain("overflow compact summary");
    expect(session?.compactSummaryTokenTotal).toBeGreaterThan(0);
    expect(result.compaction.reason).toBe("overflow");
    expect(result.events.some((event) => event.type === "compaction_started")).toBe(true);
    expect(result.events.some((event) => event.type === "compaction_completed")).toBe(true);
    expect(result.events.at(-1)?.type).toBe("run_completed");
  });
});
