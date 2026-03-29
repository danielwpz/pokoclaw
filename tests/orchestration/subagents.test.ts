import { afterEach, describe, expect, test, vi } from "vitest";

import {
  buildSubagentKickoffMessage,
  SUBAGENT_CREATION_REQUEST_TTL_MS,
  SubagentManager,
} from "@/src/orchestration/subagents.js";
import { ChannelSurfacesRepo } from "@/src/storage/repos/channel-surfaces.repo.js";
import { PermissionGrantsRepo } from "@/src/storage/repos/permission-grants.repo.js";
import { SubagentCreationRequestsRepo } from "@/src/storage/repos/subagent-creation-requests.repo.js";
import {
  createTestDatabase,
  destroyTestDatabase,
  type TestDatabaseHandle,
} from "@/tests/storage/helpers/test-db.js";

describe("subagent orchestration", () => {
  let handle: TestDatabaseHandle | null = null;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (handle != null) {
      await destroyTestDatabase(handle);
      handle = null;
    }
  });

  function seedMainAgentFixture(): void {
    if (handle == null) {
      throw new Error("test database handle is missing");
    }

    handle.storage.sqlite.exec(`
      INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
      VALUES ('ci_1', 'lark', 'acct_a', '2026-03-26T00:00:00.000Z', '2026-03-26T00:00:00.000Z');

      INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, title, created_at, updated_at)
      VALUES ('conv_main', 'ci_1', 'chat_main', 'dm', 'Main Agent', '2026-03-26T00:00:00.000Z', '2026-03-26T00:00:00.000Z');

      INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
      VALUES ('branch_main', 'conv_main', 'dm_main', 'main', '2026-03-26T00:00:00.000Z', '2026-03-26T00:00:00.000Z');

      INSERT INTO agents (id, conversation_id, kind, display_name, created_at)
      VALUES ('agent_main', 'conv_main', 'main', 'Main Agent', '2026-03-26T00:00:00.000Z');

      INSERT INTO sessions (
        id, conversation_id, branch_id, owner_agent_id, purpose, context_mode, status,
        compact_cursor, created_at, updated_at
      ) VALUES (
        'sess_main', 'conv_main', 'branch_main', 'agent_main', 'chat', 'isolated', 'active',
        0, '2026-03-26T00:00:00.000Z', '2026-03-26T00:00:01.000Z'
      );
    `);
  }

  test("submits a pending subagent creation request without provisioning immediately", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedMainAgentFixture();
    const submitMessage = vi.fn(async () => ({ status: "started" as const }));
    const provisioner = {
      provisionSubagentSurface: vi.fn(async () => ({
        status: "provisioned" as const,
        externalChatId: "chat_sub_1",
        shareLink: "https://example.com/subagent-1",
        conversationKind: "group" as const,
        channelSurface: {
          channelType: "lark",
          channelInstallationId: "default",
          surfaceKey: "chat:chat_sub_1",
          surfaceObjectJson: JSON.stringify({ chat_id: "chat_sub_1" }),
        },
      })),
    };
    const manager = new SubagentManager({
      storage: handle.storage.db,
      ingress: { submitMessage },
      provisioner,
    });

    const submittedAt = new Date("2026-03-26T00:05:00.000Z");
    const submitted = manager.submitCreateRequest({
      sourceSessionId: "sess_main",
      title: "PR Review",
      description: "Review pull requests and summarize concrete findings.",
      initialTask: "Review the current PR and report concrete issues to the user.",
      cwd: "/Users/daniel/Programs/ai/openclaw/pokeclaw",
      initialExtraScopes: [{ kind: "db.read", database: "system" }],
      createdAt: submittedAt,
    });

    expect(provisioner.provisionSubagentSurface).not.toHaveBeenCalled();
    expect(submitMessage).not.toHaveBeenCalled();
    expect(submitted.request).toMatchObject({
      sourceSessionId: "sess_main",
      sourceAgentId: "agent_main",
      sourceConversationId: "conv_main",
      channelInstanceId: "ci_1",
      title: "PR Review",
      description: "Review pull requests and summarize concrete findings.",
      initialTask: "Review the current PR and report concrete issues to the user.",
      workdir: "/Users/daniel/Programs/ai/openclaw/pokeclaw",
      status: "pending",
      createdAt: "2026-03-26T00:05:00.000Z",
    });

    const expectedExpiresAt = new Date(submittedAt.getTime() + SUBAGENT_CREATION_REQUEST_TTL_MS);
    expect(submitted.request.expiresAt).toBe(expectedExpiresAt.toISOString());
    expect(submitted.initialExtraScopes).toEqual([{ kind: "db.read", database: "system" }]);
  });

  test("approving a pending request provisions the surface, creates the subagent, grants permissions, and starts kickoff", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedMainAgentFixture();
    const submitMessage = vi.fn(async () => ({ status: "started" as const }));
    const provisioner = {
      provisionSubagentSurface: vi.fn(async () => ({
        status: "provisioned" as const,
        externalChatId: "chat_sub_1",
        shareLink: "https://example.com/subagent-1",
        conversationKind: "group" as const,
        channelSurface: {
          channelType: "lark",
          channelInstallationId: "default",
          surfaceKey: "chat:chat_sub_1",
          surfaceObjectJson: JSON.stringify({ chat_id: "chat_sub_1" }),
        },
      })),
    };
    const manager = new SubagentManager({
      storage: handle.storage.db,
      ingress: { submitMessage },
      provisioner,
    });

    const submitted = manager.submitCreateRequest({
      sourceSessionId: "sess_main",
      title: "PR Review",
      description: "Review pull requests and summarize concrete findings.",
      initialTask: "Review the current PR and report concrete issues to the user.",
      cwd: "/Users/daniel/Programs/ai/openclaw/pokeclaw",
      initialExtraScopes: [{ kind: "db.read", database: "system" }],
      createdAt: new Date("2026-03-26T00:05:00.000Z"),
    });

    const created = await manager.approveCreateRequest({
      requestId: submitted.request.id,
      decidedAt: new Date("2026-03-26T00:06:00.000Z"),
    });

    expect(provisioner.provisionSubagentSurface).toHaveBeenCalledExactlyOnceWith({
      conversationId: created.conversation.id,
      sourceConversationId: "conv_main",
      channelInstanceId: "ci_1",
      title: "PR Review",
      description: "Review pull requests and summarize concrete findings.",
      initialTask: "Review the current PR and report concrete issues to the user.",
      workdir: "/Users/daniel/Programs/ai/openclaw/pokeclaw",
      preferredSurface: "independent_chat",
    });
    expect(created.conversation).toMatchObject({
      externalChatId: "chat_sub_1",
      kind: "group",
      title: "PR Review",
    });
    expect(created.shareLink).toBe("https://example.com/subagent-1");
    expect(created.agent).toMatchObject({
      mainAgentId: "agent_main",
      kind: "sub",
      displayName: "PR Review",
      description: "Review pull requests and summarize concrete findings.",
      workdir: "/Users/daniel/Programs/ai/openclaw/pokeclaw",
    });

    const requestAfterApproval = new SubagentCreationRequestsRepo(handle.storage.db).getById(
      submitted.request.id,
    );
    expect(requestAfterApproval).toMatchObject({
      id: submitted.request.id,
      status: "created",
      createdSubagentAgentId: created.agent.id,
      decidedAt: "2026-03-26T00:06:00.000Z",
    });

    const scopes = new PermissionGrantsRepo(handle.storage.db)
      .listByOwner(created.agent.id)
      .map((grant) => JSON.parse(grant.scopeJson))
      .map((scope) => JSON.stringify(scope))
      .sort();
    expect(scopes).toEqual(
      [
        JSON.stringify({ kind: "db.read", database: "system" }),
        JSON.stringify({
          kind: "fs.read",
          path: "/Users/daniel/Programs/ai/openclaw/pokeclaw/**",
        }),
        JSON.stringify({
          kind: "fs.write",
          path: "/Users/daniel/Programs/ai/openclaw/pokeclaw/**",
        }),
      ].sort(),
    );

    expect(submitMessage).toHaveBeenCalledExactlyOnceWith({
      sessionId: created.session.id,
      scenario: "subagent",
      content: buildSubagentKickoffMessage(
        "Review the current PR and report concrete issues to the user.",
      ),
      messageType: "subagent_kickoff",
      visibility: "hidden_system",
      createdAt: new Date("2026-03-26T00:06:00.000Z"),
    });
  });

  test("denying a pending request marks it denied without provisioning", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedMainAgentFixture();
    const provisioner = {
      provisionSubagentSurface: vi.fn(async () => ({
        status: "provisioned" as const,
        externalChatId: "chat_sub_1",
        shareLink: "https://example.com/subagent-1",
        conversationKind: "group" as const,
        channelSurface: {
          channelType: "lark",
          channelInstallationId: "default",
          surfaceKey: "chat:chat_sub_1",
          surfaceObjectJson: JSON.stringify({ chat_id: "chat_sub_1" }),
        },
      })),
    };
    const manager = new SubagentManager({
      storage: handle.storage.db,
      ingress: { submitMessage: vi.fn(async () => ({ status: "started" as const })) },
      provisioner,
    });

    const submitted = manager.submitCreateRequest({
      sourceSessionId: "sess_main",
      title: "PR Review",
      description: "Review pull requests and summarize concrete findings.",
      initialTask: "Review the current PR and report concrete issues to the user.",
      createdAt: new Date("2026-03-26T00:05:00.000Z"),
    });

    const denied = manager.denyCreateRequest({
      requestId: submitted.request.id,
      reasonText: "User cancelled the request.",
      decidedAt: new Date("2026-03-26T00:06:00.000Z"),
    });

    expect(provisioner.provisionSubagentSurface).not.toHaveBeenCalled();
    expect(denied).toMatchObject({
      id: submitted.request.id,
      status: "denied",
      failureReason: "User cancelled the request.",
      decidedAt: "2026-03-26T00:06:00.000Z",
    });
  });

  test("marks the request failed and cleans up the external surface when local finalization fails", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedMainAgentFixture();
    const cleanupProvisionedSubagentSurface = vi.fn(async () => undefined);
    const provisioner = {
      provisionSubagentSurface: vi.fn(async () => ({
        status: "provisioned" as const,
        externalChatId: "chat_sub_orphan",
        shareLink: "https://example.com/subagent-orphan",
        conversationKind: "group" as const,
        channelSurface: {
          channelType: "lark",
          channelInstallationId: "default",
          surfaceKey: "chat:chat_sub_orphan",
          surfaceObjectJson: JSON.stringify({ chat_id: "chat_sub_orphan" }),
        },
      })),
      cleanupProvisionedSubagentSurface,
    };
    const manager = new SubagentManager({
      storage: handle.storage.db,
      ingress: { submitMessage: vi.fn(async () => ({ status: "started" as const })) },
      provisioner,
    });
    const surfaceUpsert = vi
      .spyOn(ChannelSurfacesRepo.prototype, "upsert")
      .mockImplementation(() => {
        throw new Error("surface write failed");
      });

    const submitted = manager.submitCreateRequest({
      sourceSessionId: "sess_main",
      title: "PR Review",
      description: "Review pull requests and summarize concrete findings.",
      initialTask: "Review the current PR and report concrete issues to the user.",
      createdAt: new Date("2026-03-26T00:05:00.000Z"),
    });

    await expect(
      manager.approveCreateRequest({
        requestId: submitted.request.id,
        decidedAt: new Date("2026-03-26T00:06:00.000Z"),
      }),
    ).rejects.toThrow("surface write failed");

    expect(surfaceUpsert).toHaveBeenCalledOnce();
    expect(cleanupProvisionedSubagentSurface).toHaveBeenCalledExactlyOnceWith({
      channelInstanceId: "ci_1",
      externalChatId: "chat_sub_orphan",
    });

    const requestAfterFailure = new SubagentCreationRequestsRepo(handle.storage.db).getById(
      submitted.request.id,
    );
    expect(requestAfterFailure).toMatchObject({
      id: submitted.request.id,
      status: "failed",
      decidedAt: "2026-03-26T00:06:00.000Z",
    });
    expect(requestAfterFailure?.failureReason).toContain("chat_sub_orphan");
    expect(requestAfterFailure?.failureReason).toContain("cleanup succeeded");
  });

  test("defaults the submitted subagent workdir to the pokeclaw workspace", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedMainAgentFixture();
    const manager = new SubagentManager({
      storage: handle.storage.db,
      ingress: { submitMessage: vi.fn(async () => ({ status: "started" as const })) },
      provisioner: {
        provisionSubagentSurface: vi.fn(async () => ({
          status: "provisioned" as const,
          externalChatId: "chat_sub_2",
          shareLink: "https://example.com/subagent-2",
          conversationKind: "group" as const,
          channelSurface: {
            channelType: "lark",
            channelInstallationId: "default",
            surfaceKey: "chat:chat_sub_2",
            surfaceObjectJson: JSON.stringify({ chat_id: "chat_sub_2" }),
          },
        })),
      },
    });

    const submitted = manager.submitCreateRequest({
      sourceSessionId: "sess_main",
      title: "Workspace Helper",
      description: "Operate inside the default workspace.",
      initialTask: "Start by checking the workspace contents.",
    });

    expect(submitted.workdir).toContain(".pokeclaw/workspace");
    expect(submitted.request.status).toBe("pending");
  });

  test("rejects subagent creation request submission from a non-main session", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedMainAgentFixture();
    handle.storage.sqlite.exec(`
      INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, title, created_at, updated_at)
      VALUES ('conv_sub_existing', 'ci_1', 'chat_sub_existing', 'group', 'Sub Existing', '2026-03-26T00:00:00.000Z', '2026-03-26T00:00:00.000Z');

      INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
      VALUES ('branch_sub_existing', 'conv_sub_existing', 'group_main', 'main', '2026-03-26T00:00:00.000Z', '2026-03-26T00:00:00.000Z');

      INSERT INTO agents (id, conversation_id, main_agent_id, kind, display_name, created_at)
      VALUES ('agent_sub_existing', 'conv_sub_existing', 'agent_main', 'sub', 'Sub Existing', '2026-03-26T00:00:00.000Z');

      INSERT INTO sessions (
        id, conversation_id, branch_id, owner_agent_id, purpose, context_mode, status,
        compact_cursor, created_at, updated_at
      ) VALUES (
        'sess_sub_existing', 'conv_sub_existing', 'branch_sub_existing', 'agent_sub_existing', 'chat',
        'isolated', 'active', 0, '2026-03-26T00:00:00.000Z', '2026-03-26T00:00:01.000Z'
      );
    `);

    const manager = new SubagentManager({
      storage: handle.storage.db,
      ingress: { submitMessage: vi.fn(async () => ({ status: "started" as const })) },
      provisioner: {
        provisionSubagentSurface: vi.fn(async () => ({
          status: "provisioned" as const,
          externalChatId: "chat_sub_3",
          shareLink: "https://example.com/subagent-3",
          conversationKind: "group" as const,
          channelSurface: {
            channelType: "lark",
            channelInstallationId: "default",
            surfaceKey: "chat:chat_sub_3",
            surfaceObjectJson: JSON.stringify({ chat_id: "chat_sub_3" }),
          },
        })),
      },
    });

    expect(() =>
      manager.submitCreateRequest({
        sourceSessionId: "sess_sub_existing",
        title: "Nested",
        description: "Should not be allowed.",
        initialTask: "Do not run.",
      }),
    ).toThrow("SubAgent creation is only allowed from a main-agent chat session");
  });

  test("builds a kickoff note that treats unclear work as background to clarify, not as already-approved detail", () => {
    const kickoff = buildSubagentKickoffMessage(
      "The user wants help with code review, but the exact target may still need clarification.",
    );

    expect(kickoff).toContain("system-generated kickoff note");
    expect(kickoff).toContain("It is not a literal user message in this chat");
    expect(kickoff).toContain("If the request is still broad, ambiguous, or missing key decisions");
    expect(kickoff).toContain("begin by greeting the user in this new conversation");
    expect(kickoff).toContain("Do not invent missing requirements");
  });
});
