import { setTimeout as delay } from "node:timers/promises";
import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, test } from "vitest";
import type { AgentAssistantContentBlock } from "@/src/agent/llm/messages.js";
import { ProviderRegistry } from "@/src/agent/llm/provider-registry.js";
import { AgentLoop, type AgentModelRunner } from "@/src/agent/loop.js";
import { AgentSessionService } from "@/src/agent/session.js";
import { DEFAULT_CONFIG } from "@/src/config/defaults.js";
import type { AppConfig } from "@/src/config/schema.js";
import { AgentManager } from "@/src/orchestration/agent-manager.js";
import { createMainAgentApprovalSessionId } from "@/src/orchestration/approval-session.js";
import { SessionRunAbortRegistry } from "@/src/runtime/cancel.js";
import { SessionRuntimeIngress } from "@/src/runtime/ingress.js";
import { ApprovalsRepo } from "@/src/storage/repos/approvals.repo.js";
import { MessagesRepo } from "@/src/storage/repos/messages.repo.js";
import { PermissionGrantsRepo } from "@/src/storage/repos/permission-grants.repo.js";
import { SessionsRepo } from "@/src/storage/repos/sessions.repo.js";
import { toolRecoverableError } from "@/src/tools/core/errors.js";
import { ToolRegistry } from "@/src/tools/core/registry.js";
import { defineTool, textToolResult } from "@/src/tools/core/types.js";
import { createRequestPermissionsTool } from "@/src/tools/request-permissions.js";
import { createReviewPermissionRequestTool } from "@/src/tools/review-permission-request.js";
import {
  createTestDatabase,
  destroyTestDatabase,
  type TestDatabaseHandle,
} from "@/tests/storage/helpers/test-db.js";

const GATED_READ_TOOL_SCHEMA = Type.Object(
  {
    path: Type.String(),
  },
  { additionalProperties: false },
);

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

function seedFixture(handle: TestDatabaseHandle): void {
  handle.storage.sqlite.exec(`
    INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
    VALUES ('ci_1', 'lark', 'acct_a', '2026-03-26T00:00:00.000Z', '2026-03-26T00:00:00.000Z');

    INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
    VALUES
      ('conv_main', 'ci_1', 'chat_main', 'dm', '2026-03-26T00:00:00.000Z', '2026-03-26T00:00:00.000Z'),
      ('conv_sub', 'ci_1', 'chat_sub', 'group', '2026-03-26T00:00:00.000Z', '2026-03-26T00:00:00.000Z');

    INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
    VALUES
      ('branch_main', 'conv_main', 'dm_main', 'main', '2026-03-26T00:00:00.000Z', '2026-03-26T00:00:00.000Z'),
      ('branch_sub', 'conv_sub', 'group_main', 'main', '2026-03-26T00:00:00.000Z', '2026-03-26T00:00:00.000Z');

    INSERT INTO agents (id, conversation_id, main_agent_id, kind, created_at)
    VALUES
      ('agent_main', 'conv_main', NULL, 'main', '2026-03-26T00:00:00.000Z'),
      ('agent_sub', 'conv_sub', 'agent_main', 'sub', '2026-03-26T00:00:00.000Z');

    INSERT INTO sessions (
      id, conversation_id, branch_id, owner_agent_id, purpose, context_mode, status,
      compact_cursor, created_at, updated_at
    ) VALUES (
      'sess_main', 'conv_main', 'branch_main', 'agent_main', 'chat', 'isolated', 'active',
      0, '2026-03-26T00:00:00.000Z', '2026-03-26T00:00:00.000Z'
    );
  `);
}

function createGatedReadTool() {
  return defineTool({
    name: "gated_read",
    description: "Reads a file only after a matching filesystem grant exists.",
    inputSchema: GATED_READ_TOOL_SCHEMA,
    execute(context, args) {
      const ownerAgentId = context.ownerAgentId;
      if (ownerAgentId == null) {
        throw toolRecoverableError("Missing agent ownership for gated read.", {
          code: "missing_owner_agent",
        });
      }

      const grantsRepo = new PermissionGrantsRepo(context.storage);
      const hasGrant = grantsRepo.listActiveByOwner(ownerAgentId).some((grant) => {
        const scope = JSON.parse(grant.scopeJson) as { kind?: string; path?: string };
        return scope.kind === "fs.read" && scope.path === args.path;
      });

      if (!hasGrant) {
        throw toolRecoverableError(`Read access is missing for ${args.path}`, {
          code: "permission_denied",
          requestable: true,
          failedToolCallId: context.toolCallId,
          summary: `Read access is missing for ${args.path}`,
          entries: [
            {
              resource: "filesystem",
              path: args.path,
              scope: "exact",
              access: "read",
            },
          ],
        });
      }

      return textToolResult(`read ok: ${args.path}`);
    },
  });
}

function createRunner(input: {
  sessionsRepo: SessionsRepo;
  approvalsRepo: ApprovalsRepo;
  taskPlan: Map<
    string,
    Array<
      | { type: "gated_read"; path: string; toolCallId: string }
      | { type: "request_permissions"; path: string; retryToolCallId: string; toolCallId: string }
      | { type: "final_text"; text: string }
    >
  >;
  approvalDecision: "approve" | "deny";
}) {
  const turnCountBySession = new Map<string, number>();

  const runner: AgentModelRunner = {
    async runTurn({ sessionId }) {
      const session = input.sessionsRepo.getById(sessionId);
      if (session == null) {
        throw new Error(`Session not found for runner: ${sessionId}`);
      }

      const turnCount = (turnCountBySession.get(sessionId) ?? 0) + 1;
      turnCountBySession.set(sessionId, turnCount);

      if (session.purpose === "approval") {
        if (turnCount % 2 === 1) {
          const sourceSessionId = session.approvalForSessionId;
          if (sourceSessionId == null) {
            throw new Error(`Approval session ${sessionId} is missing approvalForSessionId`);
          }
          const pendingApproval = input.approvalsRepo.listBySession(sourceSessionId, {
            statuses: ["pending"],
            limit: 1,
          })[0];
          if (pendingApproval == null) {
            throw new Error(`No pending approval found for source session ${sourceSessionId}`);
          }

          return makeAssistantResult({
            stopReason: "toolUse",
            content: [
              {
                type: "toolCall",
                id: `review_${pendingApproval.id}`,
                name: "review_permission_request",
                arguments: {
                  approvalId: pendingApproval.id,
                  decision: input.approvalDecision,
                  reason:
                    input.approvalDecision === "approve"
                      ? "Legitimate for this unattended task."
                      : "Not justified for this unattended task.",
                },
              },
            ],
          });
        }

        return makeAssistantResult({
          content: [{ type: "text", text: "approval reviewed" }],
        });
      }

      const plan = input.taskPlan.get(sessionId);
      if (plan == null) {
        throw new Error(`No task plan found for session ${sessionId}`);
      }
      const step = plan[turnCount - 1];
      if (step == null) {
        throw new Error(`No planned step ${turnCount} for session ${sessionId}`);
      }

      switch (step.type) {
        case "gated_read":
          return makeAssistantResult({
            stopReason: "toolUse",
            content: [
              {
                type: "toolCall",
                id: step.toolCallId,
                name: "gated_read",
                arguments: { path: step.path },
              },
            ],
          });
        case "request_permissions":
          return makeAssistantResult({
            stopReason: "toolUse",
            content: [
              {
                type: "toolCall",
                id: step.toolCallId,
                name: "request_permissions",
                arguments: {
                  entries: [
                    {
                      resource: "filesystem",
                      path: step.path,
                      scope: "exact",
                      access: "read",
                    },
                  ],
                  justification: `Need to read ${step.path} for this unattended task.`,
                  retryToolCallId: step.retryToolCallId,
                },
              },
            ],
          });
        case "final_text":
          return makeAssistantResult({
            content: [{ type: "text", text: step.text }],
          });
      }
    },
  };

  return runner;
}

async function waitFor(
  predicate: () => boolean,
  input: {
    label: string;
    timeoutMs?: number;
    intervalMs?: number;
  },
): Promise<void> {
  const timeoutMs = input.timeoutMs ?? 2_000;
  const intervalMs = input.intervalMs ?? 20;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }

    await delay(intervalMs);
  }

  throw new Error(`Timed out waiting for ${input.label}`);
}

describe("delegated approval end-to-end", () => {
  let handle: TestDatabaseHandle | null = null;

  afterEach(async () => {
    if (handle != null) {
      await destroyTestDatabase(handle);
      handle = null;
    }
  });

  test("approves a delegated permission request and resumes the same task run end-to-end", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture(handle);

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    const messagesRepo = new MessagesRepo(handle.storage.db);
    const approvalsRepo = new ApprovalsRepo(handle.storage.db);
    const taskPlan = new Map<
      string,
      ReturnType<typeof createRunner> extends never
        ? never
        : Array<
            | { type: "gated_read"; path: string; toolCallId: string }
            | {
                type: "request_permissions";
                path: string;
                retryToolCallId: string;
                toolCallId: string;
              }
            | { type: "final_text"; text: string }
          >
    >();

    taskPlan.set("pending", []);

    const runner = createRunner({
      sessionsRepo,
      approvalsRepo,
      taskPlan,
      approvalDecision: "approve",
    });

    let manager!: AgentManager;
    const loop = new AgentLoop({
      sessions: new AgentSessionService(sessionsRepo, messagesRepo),
      messages: messagesRepo,
      models: new ProviderRegistry(createModelConfig()),
      tools: new ToolRegistry([
        createGatedReadTool(),
        createRequestPermissionsTool(),
        createReviewPermissionRequestTool(),
      ]),
      cancel: new SessionRunAbortRegistry(),
      modelRunner: runner,
      storage: handle.storage.db,
      securityConfig: DEFAULT_CONFIG.security,
      compaction: DEFAULT_CONFIG.compaction,
      approvalTimeoutMs: 20,
      emitEvent(event) {
        manager.emitRuntimeEvent(event);
      },
    });

    const ingress = new SessionRuntimeIngress({
      loop,
      messages: messagesRepo,
    });
    manager = new AgentManager({
      storage: handle.storage.db,
      ingress,
    });

    const created = manager.createTaskExecution({
      runType: "delegate",
      ownerAgentId: "agent_sub",
      conversationId: "conv_sub",
      branchId: "branch_sub",
      createdAt: new Date("2026-03-26T00:00:05.000Z"),
    });
    taskPlan.delete("pending");
    taskPlan.set(created.executionSession.id, [
      { type: "gated_read", path: "/tmp/finance.csv", toolCallId: "tool_1" },
      {
        type: "request_permissions",
        path: "/tmp/finance.csv",
        retryToolCallId: "tool_1",
        toolCallId: "tool_2",
      },
      { type: "final_text", text: "task resumed after delegated approval" },
    ]);

    const result = await ingress.submitMessage({
      sessionId: created.executionSession.id,
      scenario: "task",
      content: "Run the unattended task.",
    });

    expect(result.status).toBe("started");
    await waitFor(
      () =>
        approvalsRepo.listBySession(created.executionSession.id, {
          statuses: ["approved", "cancelled"],
          limit: 10,
        }).length >= 2,
      { label: "delegated approval approval records" },
    );

    const approvals = approvalsRepo.listBySession(created.executionSession.id, {
      statuses: ["approved", "cancelled"],
      limit: 10,
    });
    expect(approvals).toHaveLength(2);
    expect(approvals.find((approval) => approval.approvalTarget === "user")).toMatchObject({
      approvalTarget: "user",
      status: "cancelled",
      reasonText: "Approval request timed out.",
    });
    const approvedRecord = approvals.find((approval) => approval.approvalTarget === "main_agent");
    expect(approvedRecord).toMatchObject({
      approvalTarget: "main_agent",
      status: "approved",
      reasonText: "Legitimate for this unattended task.",
    });
    if (approvedRecord == null) {
      throw new Error("Expected approved delegated approval record");
    }

    const approvalSessionId = createMainAgentApprovalSessionId({
      sourceSessionId: created.executionSession.id,
      approvalId: approvedRecord.id,
    });

    const sourceMessages = messagesRepo.listBySession(created.executionSession.id);
    expect(sourceMessages.map((row) => row.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(JSON.parse(sourceMessages[4]?.payloadJson ?? "{}")).toMatchObject({
      toolName: "request_permissions",
      isError: false,
    });
    expect(JSON.parse(sourceMessages[5]?.payloadJson ?? "{}")).toEqual({
      content: [{ type: "text", text: "task resumed after delegated approval" }],
    });

    const approvalMessages = messagesRepo.listBySession(approvalSessionId);
    expect(approvalMessages.map((row) => row.messageType)).toEqual([
      "approval_request",
      "text",
      "tool_result",
    ]);
    expect(approvalMessages[0]?.visibility).toBe("hidden_system");
    expect(JSON.parse(approvalMessages[2]?.payloadJson ?? "{}")).toMatchObject({
      toolName: "review_permission_request",
      isError: false,
    });

    const grantsRepo = new PermissionGrantsRepo(handle.storage.db);
    const activeGrants = grantsRepo.listActiveByOwner("agent_sub");
    expect(activeGrants).toHaveLength(1);
    expect(JSON.parse(activeGrants[0]?.scopeJson ?? "{}")).toEqual({
      kind: "fs.read",
      path: "/tmp/finance.csv",
    });
  });

  test("denies a delegated permission request and returns the denial to the same task run", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture(handle);

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    const messagesRepo = new MessagesRepo(handle.storage.db);
    const approvalsRepo = new ApprovalsRepo(handle.storage.db);
    const taskPlan = new Map<
      string,
      Array<
        | { type: "gated_read"; path: string; toolCallId: string }
        | { type: "request_permissions"; path: string; retryToolCallId: string; toolCallId: string }
        | { type: "final_text"; text: string }
      >
    >();

    const runner = createRunner({
      sessionsRepo,
      approvalsRepo,
      taskPlan,
      approvalDecision: "deny",
    });

    let manager!: AgentManager;
    const loop = new AgentLoop({
      sessions: new AgentSessionService(sessionsRepo, messagesRepo),
      messages: messagesRepo,
      models: new ProviderRegistry(createModelConfig()),
      tools: new ToolRegistry([
        createGatedReadTool(),
        createRequestPermissionsTool(),
        createReviewPermissionRequestTool(),
      ]),
      cancel: new SessionRunAbortRegistry(),
      modelRunner: runner,
      storage: handle.storage.db,
      securityConfig: DEFAULT_CONFIG.security,
      compaction: DEFAULT_CONFIG.compaction,
      approvalTimeoutMs: 20,
      emitEvent(event) {
        manager.emitRuntimeEvent(event);
      },
    });

    const ingress = new SessionRuntimeIngress({
      loop,
      messages: messagesRepo,
    });
    manager = new AgentManager({
      storage: handle.storage.db,
      ingress,
    });

    const created = manager.createTaskExecution({
      runType: "delegate",
      ownerAgentId: "agent_sub",
      conversationId: "conv_sub",
      branchId: "branch_sub",
      createdAt: new Date("2026-03-26T00:00:05.000Z"),
    });
    taskPlan.set(created.executionSession.id, [
      { type: "gated_read", path: "/tmp/private.csv", toolCallId: "tool_1" },
      {
        type: "request_permissions",
        path: "/tmp/private.csv",
        retryToolCallId: "tool_1",
        toolCallId: "tool_2",
      },
      { type: "final_text", text: "permission was denied" },
    ]);

    const result = await ingress.submitMessage({
      sessionId: created.executionSession.id,
      scenario: "task",
      content: "Run the unattended task.",
    });

    expect(result.status).toBe("started");
    await waitFor(
      () =>
        approvalsRepo.listBySession(created.executionSession.id, {
          statuses: ["denied", "cancelled"],
          limit: 10,
        }).length >= 2,
      { label: "delegated denial approval records" },
    );

    const approvals = approvalsRepo.listBySession(created.executionSession.id, {
      statuses: ["denied", "cancelled"],
      limit: 10,
    });
    expect(approvals).toHaveLength(2);
    expect(approvals.find((approval) => approval.approvalTarget === "user")).toMatchObject({
      approvalTarget: "user",
      status: "cancelled",
      reasonText: "Approval request timed out.",
    });
    expect(approvals.find((approval) => approval.approvalTarget === "main_agent")).toMatchObject({
      approvalTarget: "main_agent",
      status: "denied",
      reasonText: "Not justified for this unattended task.",
    });

    const sourceMessages = messagesRepo.listBySession(created.executionSession.id);
    expect(JSON.parse(sourceMessages[4]?.payloadJson ?? "{}")).toMatchObject({
      toolName: "request_permissions",
      isError: true,
      content: [
        {
          type: "text",
          text: expect.stringContaining("<permission_request_result>"),
        },
      ],
    });
    expect(JSON.parse(sourceMessages[5]?.payloadJson ?? "{}")).toEqual({
      content: [{ type: "text", text: "permission was denied" }],
    });

    const grantsRepo = new PermissionGrantsRepo(handle.storage.db);
    expect(grantsRepo.listActiveByOwner("agent_sub")).toHaveLength(0);
  });

  test("reuses one approval session for multiple delegated approvals within the same task run", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture(handle);

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    const messagesRepo = new MessagesRepo(handle.storage.db);
    const approvalsRepo = new ApprovalsRepo(handle.storage.db);
    const taskPlan = new Map<
      string,
      Array<
        | { type: "gated_read"; path: string; toolCallId: string }
        | { type: "request_permissions"; path: string; retryToolCallId: string; toolCallId: string }
        | { type: "final_text"; text: string }
      >
    >();

    const runner = createRunner({
      sessionsRepo,
      approvalsRepo,
      taskPlan,
      approvalDecision: "approve",
    });

    let manager!: AgentManager;
    const loop = new AgentLoop({
      sessions: new AgentSessionService(sessionsRepo, messagesRepo),
      messages: messagesRepo,
      models: new ProviderRegistry(createModelConfig()),
      tools: new ToolRegistry([
        createGatedReadTool(),
        createRequestPermissionsTool(),
        createReviewPermissionRequestTool(),
      ]),
      cancel: new SessionRunAbortRegistry(),
      modelRunner: runner,
      storage: handle.storage.db,
      securityConfig: DEFAULT_CONFIG.security,
      compaction: DEFAULT_CONFIG.compaction,
      approvalTimeoutMs: 20,
      emitEvent(event) {
        manager.emitRuntimeEvent(event);
      },
    });

    const ingress = new SessionRuntimeIngress({
      loop,
      messages: messagesRepo,
    });
    manager = new AgentManager({
      storage: handle.storage.db,
      ingress,
    });

    const created = manager.createTaskExecution({
      runType: "delegate",
      ownerAgentId: "agent_sub",
      conversationId: "conv_sub",
      branchId: "branch_sub",
      createdAt: new Date("2026-03-26T00:00:05.000Z"),
    });
    taskPlan.set(created.executionSession.id, [
      { type: "gated_read", path: "/tmp/one.csv", toolCallId: "tool_1" },
      {
        type: "request_permissions",
        path: "/tmp/one.csv",
        retryToolCallId: "tool_1",
        toolCallId: "tool_2",
      },
      { type: "gated_read", path: "/tmp/two.csv", toolCallId: "tool_3" },
      {
        type: "request_permissions",
        path: "/tmp/two.csv",
        retryToolCallId: "tool_3",
        toolCallId: "tool_4",
      },
      { type: "final_text", text: "both approvals completed" },
    ]);

    const result = await ingress.submitMessage({
      sessionId: created.executionSession.id,
      scenario: "task",
      content: "Run the unattended task.",
    });

    expect(result.status).toBe("started");
    await waitFor(
      () =>
        approvalsRepo.listBySession(created.executionSession.id, {
          statuses: ["approved", "cancelled"],
          limit: 10,
        }).length >= 4,
      { label: "multiple delegated approval records" },
    );

    const approvals = approvalsRepo.listBySession(created.executionSession.id, {
      statuses: ["approved", "cancelled"],
      limit: 10,
    });
    expect(approvals).toHaveLength(4);
    expect(approvals.filter((approval) => approval.approvalTarget === "user")).toHaveLength(2);
    const delegatedApprovals = approvals
      .filter((approval) => approval.approvalTarget === "main_agent")
      .sort((left, right) => left.id - right.id);
    expect(delegatedApprovals).toHaveLength(2);
    const firstApproval = delegatedApprovals[0];
    if (firstApproval == null) {
      throw new Error("Expected first approval record for reused approval session");
    }

    const approvalSessionId = createMainAgentApprovalSessionId({
      sourceSessionId: created.executionSession.id,
      approvalId: firstApproval.id,
    });
    const approvalRows = handle.storage.sqlite
      .prepare(
        "SELECT id FROM sessions WHERE purpose = 'approval' AND approval_for_session_id = ? ORDER BY created_at ASC",
      )
      .all(created.executionSession.id) as Array<{ id: string }>;
    expect(approvalRows).toEqual([{ id: approvalSessionId }]);

    const approvalMessages = messagesRepo.listBySession(approvalSessionId);
    expect(
      approvalMessages.filter(
        (row) => row.messageType === "approval_request" && row.role === "user",
      ).length,
    ).toBe(2);

    const sourceMessages = messagesRepo.listBySession(created.executionSession.id);
    expect(JSON.parse(sourceMessages.at(-1)?.payloadJson ?? "{}")).toEqual({
      content: [{ type: "text", text: "both approvals completed" }],
    });
  });
});
