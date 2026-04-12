import { afterEach, describe, expect, test, vi } from "vitest";

import { createLarkSubagentConversationSurfaceProvisioner } from "@/src/channels/lark/subagent-provisioner.js";
import {
  createTestDatabase,
  destroyTestDatabase,
  type TestDatabaseHandle,
} from "@/tests/storage/helpers/test-db.js";

describe("lark subagent provisioner", () => {
  let handle: TestDatabaseHandle | null = null;

  afterEach(async () => {
    if (handle != null) {
      await destroyTestDatabase(handle);
      handle = null;
    }
  });

  test("creates a group and derives a reusable channel surface from the source conversation", async () => {
    handle = await createTestDatabase(import.meta.url);
    handle.storage.sqlite.exec(`
      INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
      VALUES ('ci_1', 'lark', 'default', '2026-03-29T00:00:00.000Z', '2026-03-29T00:00:00.000Z');

      INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, title, created_at, updated_at)
      VALUES ('conv_main', 'ci_1', 'chat_main', 'dm', 'Main', '2026-03-29T00:00:00.000Z', '2026-03-29T00:00:00.000Z');
    `);

    const chatCreate = vi.fn(async () => ({ data: { chat_id: "chat_sub_1" } }));
    const chatDelete = vi.fn(async () => ({ data: {} }));
    const chatLink = vi.fn(async () => ({
      data: { share_link: "https://example.com/subagent-1" },
    }));
    const chatMembersGet = vi.fn(async () => ({
      data: {
        items: [{ member_id: "ou_user_1" }, { member_id: "ou_user_2" }],
        has_more: false,
      },
    }));
    const chatMembersCreate = vi.fn(async () => ({ data: { invalid_id_list: [] } }));
    const messageCreate = vi.fn(async () => ({ data: { message_id: "om_welcome_1" } }));
    const putTopNotice = vi.fn(async () => ({ data: {} }));

    const provisioner = createLarkSubagentConversationSurfaceProvisioner({
      storage: handle.storage.db,
      clients: {
        getOrCreate: () =>
          ({
            sdk: {
              im: {
                chat: {
                  create: chatCreate,
                  delete: chatDelete,
                  link: chatLink,
                },
                chatMembers: {
                  get: chatMembersGet,
                  create: chatMembersCreate,
                },
                message: {
                  create: messageCreate,
                },
                chatTopNotice: {
                  putTopNotice,
                },
              },
            },
          }) as never,
      },
    });

    const result = await provisioner.provisionSubagentSurface({
      conversationId: "conv_sub_1",
      sourceConversationId: "conv_main",
      channelInstanceId: "ci_1",
      title: "PR Review",
      description: "Review pull requests and summarize findings.",
      initialTask: "Review the current PR and report concrete issues.",
      workdir: "/Users/example/work/pokoclaw",
      privateWorkspaceDir: "/Users/example/.pokoclaw/workspace/subagents/abcd1234",
      preferredSurface: "independent_chat",
    });

    expect(result).toMatchObject({
      status: "provisioned",
      externalChatId: "chat_sub_1",
      shareLink: "https://example.com/subagent-1",
      conversationKind: "group",
      channelSurface: {
        channelType: "lark",
        channelInstallationId: "default",
        surfaceKey: "chat:chat_sub_1",
      },
    });
    expect(chatCreate).toHaveBeenCalledOnce();
    expect(chatCreate).toHaveBeenCalledWith({
      data: {
        name: "PR Review",
      },
    });
    expect(chatDelete).not.toHaveBeenCalled();
    expect(chatMembersGet).toHaveBeenCalledExactlyOnceWith({
      path: { chat_id: "chat_main" },
      params: {
        member_id_type: "open_id",
        page_size: 100,
      },
    });
    expect(chatMembersCreate).toHaveBeenCalledExactlyOnceWith({
      path: { chat_id: "chat_sub_1" },
      params: { member_id_type: "open_id" },
      data: { id_list: ["ou_user_1", "ou_user_2"] },
    });
    expect(chatLink).toHaveBeenCalledExactlyOnceWith({
      path: { chat_id: "chat_sub_1" },
      data: { validity_period: "permanently" },
    });
    expect(messageCreate).toHaveBeenCalledExactlyOnceWith({
      params: { receive_id_type: "chat_id" },
      data: expect.objectContaining({
        receive_id: "chat_sub_1",
        msg_type: "interactive",
        content: expect.stringContaining("欢迎来到 PR Review"),
      }),
    });
    const welcomeCall = messageCreate.mock.calls[0] as [{ data: { content: string } }] | undefined;
    expect(welcomeCall).toBeDefined();
    const welcomeContent = welcomeCall?.[0].data.content ?? "";
    const welcomeCard = JSON.parse(welcomeContent) as {
      body?: { elements?: Array<Record<string, unknown>> };
    };
    const initialTaskPanel = welcomeCard.body?.elements?.find(
      (element) =>
        element.tag === "collapsible_panel" &&
        typeof element.header === "object" &&
        element.header != null,
    ) as
      | {
          tag: string;
          expanded?: boolean;
          header?: { title?: { content?: string } };
        }
      | undefined;

    expect(welcomeContent).toContain(
      "**私有工作区**：`/Users/example/.pokoclaw/workspace/subagents/abcd1234`",
    );
    expect(welcomeContent).not.toContain("**初始任务**：Review the current PR");
    expect(welcomeContent).toContain(
      "工作目录` 是默认执行目录；`私有工作区` 用于笔记、scratch 文件、导出物和其他临时产物。",
    );
    expect(initialTaskPanel).toBeDefined();
    expect(initialTaskPanel?.expanded).toBe(false);
    expect(initialTaskPanel?.header?.title?.content).toContain("初始任务");
    expect(putTopNotice).toHaveBeenCalledExactlyOnceWith({
      path: { chat_id: "chat_sub_1" },
      data: {
        chat_top_notice: [{ action_type: "1", message_id: "om_welcome_1" }],
      },
    });
  });

  test("cleans up the created chat when provisioning fails after chat.create", async () => {
    handle = await createTestDatabase(import.meta.url);
    handle.storage.sqlite.exec(`
      INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
      VALUES ('ci_1', 'lark', 'default', '2026-03-29T00:00:00.000Z', '2026-03-29T00:00:00.000Z');

      INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, title, created_at, updated_at)
      VALUES ('conv_main', 'ci_1', 'chat_main', 'dm', 'Main', '2026-03-29T00:00:00.000Z', '2026-03-29T00:00:00.000Z');
    `);

    const chatCreate = vi.fn(async () => ({ data: { chat_id: "chat_sub_2" } }));
    const chatDelete = vi.fn(async () => ({ data: {} }));
    const chatMembersGet = vi.fn(async () => ({
      data: {
        items: [{ member_id: "ou_user_1" }],
        has_more: false,
      },
    }));
    const chatMembersCreate = vi.fn(async () => {
      throw new Error("member add failed");
    });

    const provisioner = createLarkSubagentConversationSurfaceProvisioner({
      storage: handle.storage.db,
      clients: {
        getOrCreate: () =>
          ({
            sdk: {
              im: {
                chat: {
                  create: chatCreate,
                  delete: chatDelete,
                  link: vi.fn(async () => ({ data: {} })),
                },
                chatMembers: {
                  get: chatMembersGet,
                  create: chatMembersCreate,
                },
                message: {
                  create: vi.fn(async () => ({ data: { message_id: "om_welcome_2" } })),
                },
                chatTopNotice: {
                  putTopNotice: vi.fn(async () => ({ data: {} })),
                },
              },
            },
          }) as never,
      },
    });

    const result = await provisioner.provisionSubagentSurface({
      conversationId: "conv_sub_2",
      sourceConversationId: "conv_main",
      channelInstanceId: "ci_1",
      title: "PR Review",
      description: "Review pull requests and summarize findings.",
      initialTask: "Review the current PR and report concrete issues.",
      workdir: "/Users/example/work/pokoclaw",
      privateWorkspaceDir: "/Users/example/.pokoclaw/workspace/subagents/abcd1234",
      preferredSurface: "independent_chat",
    });

    expect(result).toMatchObject({
      status: "failed",
      reason: "member add failed",
      retryable: true,
    });
    expect(chatDelete).toHaveBeenCalledExactlyOnceWith({
      path: { chat_id: "chat_sub_2" },
    });
  });

  test("supports explicit cleanup of a provisioned subagent chat", async () => {
    handle = await createTestDatabase(import.meta.url);
    handle.storage.sqlite.exec(`
      INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
      VALUES ('ci_1', 'lark', 'default', '2026-03-29T00:00:00.000Z', '2026-03-29T00:00:00.000Z');
    `);

    const chatDelete = vi.fn(async () => ({ data: {} }));
    const provisioner = createLarkSubagentConversationSurfaceProvisioner({
      storage: handle.storage.db,
      clients: {
        getOrCreate: () =>
          ({
            sdk: {
              im: {
                chat: {
                  delete: chatDelete,
                },
              },
            },
          }) as never,
      },
    });

    await provisioner.cleanupProvisionedSubagentSurface({
      channelInstanceId: "ci_1",
      externalChatId: "chat_sub_cleanup",
    });

    expect(chatDelete).toHaveBeenCalledExactlyOnceWith({
      path: { chat_id: "chat_sub_cleanup" },
    });
  });
});
