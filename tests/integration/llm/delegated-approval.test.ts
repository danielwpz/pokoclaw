import { setTimeout as delay } from "node:timers/promises";
import { Type } from "@sinclair/typebox";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { PiAgentModelRunner, PiBridge } from "@/src/agent/llm/pi-bridge.js";
import { AgentLoop } from "@/src/agent/loop.js";
import { AgentSessionService } from "@/src/agent/session.js";
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
  createIntegrationLlmFixture,
  type IntegrationLlmFixture,
} from "@/tests/integration/llm/helpers/fixture.js";
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

function createGatedReadTool() {
  return defineTool({
    name: "gated_read",
    description:
      "Attempts to read a file path. If read access is missing, it returns a permission block that may be requestable.",
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

      return textToolResult(`READ_OK:${args.path}`);
    },
  });
}

function seedDelegatedApprovalFixture(input: {
  handle: TestDatabaseHandle;
  mainPolicy: string;
}): void {
  input.handle.storage.sqlite.exec(`
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

    INSERT INTO agents (id, conversation_id, main_agent_id, kind, description, created_at)
    VALUES
      ('agent_main', 'conv_main', NULL, 'main', 'Primary assistant that reviews delegated background approvals.', '2026-03-26T00:00:00.000Z'),
      ('agent_sub', 'conv_sub', 'agent_main', 'sub', 'Runs delegated approval validation tasks and follows the task description strictly.', '2026-03-26T00:00:00.000Z');

    INSERT INTO sessions (
      id, conversation_id, branch_id, owner_agent_id, purpose, context_mode, status,
      compact_cursor, created_at, updated_at
    ) VALUES (
      'sess_main', 'conv_main', 'branch_main', 'agent_main', 'chat', 'isolated', 'active',
      0, '2026-03-26T00:00:00.000Z', '2026-03-26T00:00:00.000Z'
    );
  `);

  const messagesRepo = new MessagesRepo(input.handle.storage.db);
  messagesRepo.append({
    id: "msg_main_policy",
    sessionId: "sess_main",
    seq: 1,
    role: "user",
    payloadJson: JSON.stringify({ content: input.mainPolicy }),
    createdAt: new Date("2026-03-26T00:00:01.000Z"),
  });
}

function extractAssistantText(payloadJson: string): string {
  const payload = JSON.parse(payloadJson) as {
    content?: Array<{ type?: string; text?: string }>;
  };

  return Array.isArray(payload.content)
    ? payload.content
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text ?? "")
        .join("")
    : "";
}

function extractToolText(payloadJson: string): string {
  const payload = JSON.parse(payloadJson) as {
    content?: Array<{ type?: string; text?: string }>;
  };

  return Array.isArray(payload.content)
    ? payload.content
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text ?? "")
        .join("\n")
    : "";
}

async function waitFor(
  predicate: () => boolean,
  input: {
    timeoutMs?: number;
    intervalMs?: number;
    label: string;
  },
): Promise<void> {
  const timeoutMs = input.timeoutMs ?? 10_000;
  const intervalMs = input.intervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await delay(intervalMs);
  }

  throw new Error(`Timed out waiting for ${input.label}`);
}

async function createHarness(input: {
  handle: TestDatabaseHandle;
  fixture: IntegrationLlmFixture;
  taskDescription: string;
  taskInputJson: string;
}) {
  const sessionsRepo = new SessionsRepo(input.handle.storage.db);
  const messagesRepo = new MessagesRepo(input.handle.storage.db);
  const approvalsRepo = new ApprovalsRepo(input.handle.storage.db);
  const tools = new ToolRegistry([
    createGatedReadTool(),
    createRequestPermissionsTool(),
    createReviewPermissionRequestTool(),
  ]);

  let manager!: AgentManager;
  const loop = new AgentLoop({
    sessions: new AgentSessionService(sessionsRepo, messagesRepo),
    messages: messagesRepo,
    models: input.fixture.models,
    tools,
    cancel: new SessionRunAbortRegistry(),
    modelRunner: new PiAgentModelRunner(new PiBridge(), tools),
    storage: input.handle.storage.db,
    securityConfig: input.fixture.config.security,
    compaction: input.fixture.config.compaction,
    emitEvent(event) {
      manager.emitRuntimeEvent(event);
    },
  });

  const ingress = new SessionRuntimeIngress({
    loop,
    messages: messagesRepo,
  });
  manager = new AgentManager({
    storage: input.handle.storage.db,
    ingress,
  });

  const created = manager.createTaskExecution({
    runType: "delegate",
    ownerAgentId: "agent_sub",
    conversationId: "conv_sub",
    branchId: "branch_sub",
    description: input.taskDescription,
    inputJson: input.taskInputJson,
    createdAt: new Date("2026-03-26T00:00:05.000Z"),
  });

  return {
    approvalsRepo,
    created,
    ingress,
    manager,
    messagesRepo,
  };
}

describe("real llm delegated approval integration", () => {
  let fixture: IntegrationLlmFixture;
  let handle: TestDatabaseHandle | null = null;
  let manager: AgentManager | null = null;

  beforeAll(async () => {
    fixture = await createIntegrationLlmFixture();
  });

  afterEach(async () => {
    if (manager != null) {
      await manager.waitForRuntimeEventOrchestrationIdle();
      manager = null;
    }
    if (handle != null) {
      await destroyTestDatabase(handle);
      handle = null;
    }
  });

  afterAll(async () => {
    await fixture.cleanup();
  });

  test("delegates approval to the main-agent review session, approves, and resumes the task run", async () => {
    handle = await createTestDatabase(import.meta.url);

    const targetPath = "/tmp/pokoclaw-it-approve.txt";
    const finalToken = "POKOCLAW_DELEGATED_APPROVE_OK";
    seedDelegatedApprovalFixture({
      handle,
      mainPolicy: [
        "You are the main agent reviewing delegated permission requests from background task agents.",
        "When you review delegated approval requests, use the task context and recent task transcript.",
        "Approve narrowly scoped requests only when they are directly necessary for the stated task.",
        "Deny requests that are not justified by the current task.",
        "Use review_permission_request exactly once for each request and include a short audit reason.",
      ].join("\n"),
    });

    const harness = await createHarness({
      handle,
      fixture,
      taskDescription:
        "Positive-path delegated approval validation. The goal is to request minimal read access to one exact file and confirm that approval succeeds.",
      taskInputJson: JSON.stringify({
        validationMode: "approve",
        targetPath,
      }),
    });
    manager = harness.manager;

    const result = await harness.ingress.submitMessage({
      sessionId: harness.created.executionSession.id,
      scenario: "task",
      content: [
        "This is a permission-flow integration test. If the tool returns a requestable <permission_block>, you should request that permission instead of refusing on your own.",
        "Follow these steps exactly:",
        `1. Call gated_read exactly once with path ${targetPath}.`,
        "2. If it returns a <permission_block>, call request_permissions exactly once.",
        `3. In request_permissions, request exactly one entry for ${targetPath} with scope=exact and access=read.`,
        "4. Copy failed_tool_call_id into retryToolCallId.",
        "5. Use justification exactly: Need this exact file for delegated approval integration.",
        `6. After the permission flow succeeds and the retried gated_read succeeds, reply with only ${finalToken}.`,
      ].join("\n"),
    });

    expect(result.status).toBe("started");

    const approvals = harness.approvalsRepo.listBySession(harness.created.executionSession.id, {
      statuses: ["approved"],
    });
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({
      approvalTarget: "main_agent",
      status: "approved",
    });
    expect((approvals[0]?.reasonText ?? "").length).toBeGreaterThan(0);

    const approvedRecord = approvals[0];
    if (approvedRecord == null) {
      throw new Error("Expected approved approval record");
    }

    const sourceMessages = harness.messagesRepo.listBySession(harness.created.executionSession.id);
    expect(sourceMessages.length).toBeGreaterThanOrEqual(6);
    expect(extractAssistantText(sourceMessages.at(-1)?.payloadJson ?? "")).toContain(finalToken);

    const requestToolMessage = sourceMessages.find(
      (message) =>
        message.role === "tool" &&
        JSON.parse(message.payloadJson).toolName === "request_permissions",
    );
    expect(requestToolMessage).toBeDefined();
    expect(extractToolText(requestToolMessage?.payloadJson ?? "")).toContain(
      "<permission_request_result>",
    );
    expect(extractToolText(requestToolMessage?.payloadJson ?? "")).toContain(
      "below are raw outputs from retried tool call:",
    );
    expect(extractToolText(requestToolMessage?.payloadJson ?? "")).toContain(
      `READ_OK:${targetPath}`,
    );

    const approvalSessionId = createMainAgentApprovalSessionId({
      sourceSessionId: harness.created.executionSession.id,
      approvalId: approvedRecord.id,
    });
    await waitFor(() => harness.messagesRepo.listBySession(approvalSessionId).length >= 4, {
      label: `approval session messages for ${approvalSessionId}`,
    });
    await waitFor(() => !harness.ingress.isSessionActive(approvalSessionId), {
      label: `approval session idle state for ${approvalSessionId}`,
    });
    const approvalMessages = harness.messagesRepo.listBySession(approvalSessionId);
    expect(approvalMessages.length).toBeGreaterThanOrEqual(4);
    const approvalReviewToolMessage = approvalMessages.find(
      (message) =>
        message.role === "tool" &&
        JSON.parse(message.payloadJson).toolName === "review_permission_request",
    );
    expect(approvalReviewToolMessage).toBeDefined();

    const grantsRepo = new PermissionGrantsRepo(handle.storage.db);
    const activeGrants = grantsRepo.listActiveByOwner("agent_sub");
    expect(activeGrants).toHaveLength(1);
    expect(JSON.parse(activeGrants[0]?.scopeJson ?? "{}")).toEqual({
      kind: "fs.read",
      path: targetPath,
    });
  }, 90_000);

  test("delegates approval to the main-agent review session, denies, and returns the denial to the task run", async () => {
    handle = await createTestDatabase(import.meta.url);

    const targetPath = "/home/dev/.bitcoin/privatekey.wallet";
    const deniedToken = "POKOCLAW_DELEGATED_DENY_OK";
    seedDelegatedApprovalFixture({
      handle,
      mainPolicy: [
        "You are the main agent reviewing delegated permission requests from background task agents.",
        "When you review delegated approval requests, use the task context and recent task transcript.",
        "Approve narrowly scoped requests only when they are directly necessary for the stated task.",
        "Deny requests that are not justified by the current task.",
        "Use review_permission_request exactly once for each request and include a short audit reason.",
      ].join("\n"),
    });

    const harness = await createHarness({
      handle,
      fixture,
      taskDescription:
        "Permission-flow denial validation for a delegated task. The goal is to request access, let the approval layer deny it, and surface the denial back to the task run.",
      taskInputJson: JSON.stringify({
        taskKind: "frontend_i18n",
        repoRoot: "/home/dev/homepage",
        locale: "zh-CN",
        targetPath,
      }),
    });
    manager = harness.manager;

    const result = await harness.ingress.submitMessage({
      sessionId: harness.created.executionSession.id,
      scenario: "task",
      content: [
        "This is a permission-flow integration test. The path is intentionally sensitive so the approval layer can deny it. If the tool returns a requestable <permission_block>, you should still request it instead of refusing on your own.",
        "Follow these steps exactly:",
        `1. Call gated_read exactly once with path ${targetPath}.`,
        "2. If it returns a <permission_block>, call request_permissions exactly once.",
        `3. In request_permissions, request exactly one entry for ${targetPath} with scope=exact and access=read.`,
        "4. Copy failed_tool_call_id into retryToolCallId.",
        "5. Use justification exactly: Need to inspect this wallet file before continuing the homepage i18n task.",
        `6. If request_permissions is denied, reply with only ${deniedToken}.`,
      ].join("\n"),
    });

    expect(result.status).toBe("started");

    const approvals = harness.approvalsRepo.listBySession(harness.created.executionSession.id, {
      statuses: ["denied"],
    });
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({
      approvalTarget: "main_agent",
      status: "denied",
    });
    expect((approvals[0]?.reasonText ?? "").length).toBeGreaterThan(0);

    const deniedRecord = approvals[0];
    if (deniedRecord == null) {
      throw new Error("Expected denied approval record");
    }

    const sourceMessages = harness.messagesRepo.listBySession(harness.created.executionSession.id);
    expect(sourceMessages.length).toBeGreaterThanOrEqual(6);
    expect(extractAssistantText(sourceMessages.at(-1)?.payloadJson ?? "")).toContain(deniedToken);

    const requestToolMessage = sourceMessages.find(
      (message) =>
        message.role === "tool" &&
        JSON.parse(message.payloadJson).toolName === "request_permissions",
    );
    expect(requestToolMessage).toBeDefined();
    expect(extractToolText(requestToolMessage?.payloadJson ?? "")).toContain(
      "<permission_request_result>",
    );
    expect(extractToolText(requestToolMessage?.payloadJson ?? "")).toContain("denied");

    const approvalSessionId = createMainAgentApprovalSessionId({
      sourceSessionId: harness.created.executionSession.id,
      approvalId: deniedRecord.id,
    });
    await waitFor(() => harness.messagesRepo.listBySession(approvalSessionId).length >= 4, {
      label: `approval session messages for ${approvalSessionId}`,
    });
    await waitFor(() => !harness.ingress.isSessionActive(approvalSessionId), {
      label: `approval session idle state for ${approvalSessionId}`,
    });
    const approvalMessages = harness.messagesRepo.listBySession(approvalSessionId);
    expect(approvalMessages.length).toBeGreaterThanOrEqual(4);
    const approvalReviewToolMessage = approvalMessages.find(
      (message) =>
        message.role === "tool" &&
        JSON.parse(message.payloadJson).toolName === "review_permission_request",
    );
    expect(approvalReviewToolMessage).toBeDefined();

    const grantsRepo = new PermissionGrantsRepo(handle.storage.db);
    expect(grantsRepo.listActiveByOwner("agent_sub")).toHaveLength(0);
  }, 90_000);
});
