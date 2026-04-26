import { describe, expect, test, vi } from "vitest";
import type { LarkSdkClient } from "@/src/channels/lark/client.js";
import {
  buildLarkChatSurfaceKey,
  buildLarkThreadSurfaceKey,
  createLarkMessageReceiveHandler,
} from "@/src/channels/lark/inbound.js";
import { SessionRunAbortRegistry } from "@/src/runtime/cancel.js";
import { RuntimeControlService } from "@/src/runtime/control.js";
import type { RuntimeStatusService } from "@/src/runtime/status.js";
import { ChannelSurfacesRepo } from "@/src/storage/repos/channel-surfaces.repo.js";
import { LarkObjectBindingsRepo } from "@/src/storage/repos/lark-object-bindings.repo.js";
import { makeTextEvent, seedFixture, withHandle } from "./fixtures.js";

describe("lark inbound slash commands", () => {
  test("routes /stop to control service instead of runtime ingress", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);
      const surfacesRepo = new ChannelSurfacesRepo(handle.storage.db);
      surfacesRepo.upsert({
        id: "surface_1",
        channelType: "lark",
        channelInstallationId: "default",
        conversationId: "conv_main",
        branchId: "branch_main",
        surfaceKey: buildLarkChatSurfaceKey("oc_chat_1"),
        surfaceObjectJson: JSON.stringify({ chat_id: "oc_chat_1" }),
      });

      const submitMessage = vi.fn(async () => ({ status: "started" as const }));
      const control = {
        stopConversation: vi.fn(() => ({
          acceptedCount: 1,
          conversationId: "conv_main",
          runIds: ["run_1"],
          sessionIds: ["sess_chat_1"],
        })),
      } as unknown as RuntimeControlService;
      const handler = createLarkMessageReceiveHandler({
        installationId: "default",
        storage: handle.storage.db,
        ingress: { submitMessage, submitApprovalDecision: vi.fn(() => false) },
        control,
      });

      await handler(makeTextEvent("/stop"));

      expect(submitMessage).not.toHaveBeenCalled();
      expect(control.stopConversation).toHaveBeenCalledExactlyOnceWith({
        conversationId: "conv_main",
        actor: "lark:default:ou_sender",
        sourceKind: "command",
        requestScope: "conversation",
        reasonText: "stop requested from lark command",
      });
    });
  });

  test("routes /stop inside an ordinary thread to the thread session only", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);
      handle.storage.sqlite.exec(`
        INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, external_branch_id, parent_branch_id, created_at, updated_at)
        VALUES ('branch_thread_1', 'conv_main', 'dm_thread', 'thread:omt_thread_1', 'omt_thread_1', 'branch_main', '2026-03-27T00:00:03.000Z', '2026-03-27T00:00:03.000Z');

        INSERT INTO sessions (id, conversation_id, branch_id, owner_agent_id, purpose, status, created_at, updated_at)
        VALUES ('sess_thread_1', 'conv_main', 'branch_thread_1', 'agent_main', 'chat', 'active', '2026-03-27T00:00:03.000Z', '2026-03-27T00:00:04.000Z');
      `);
      new ChannelSurfacesRepo(handle.storage.db).upsert({
        id: "surface_thread_1",
        channelType: "lark",
        channelInstallationId: "default",
        conversationId: "conv_main",
        branchId: "branch_thread_1",
        surfaceKey: buildLarkThreadSurfaceKey("oc_chat_1", "omt_thread_1"),
        surfaceObjectJson: JSON.stringify({
          chat_id: "oc_chat_1",
          thread_id: "omt_thread_1",
          reply_to_message_id: "om_parent_1",
        }),
      });

      const submitMessage = vi.fn(async () => ({ status: "started" as const }));
      const control = {
        stopSession: vi.fn(() => ({
          accepted: true,
          sessionId: "sess_thread_1",
          runIds: ["run_thread_1"],
          conversationId: "conv_main",
        })),
        stopConversation: vi.fn(),
      } as unknown as RuntimeControlService;
      const handler = createLarkMessageReceiveHandler({
        installationId: "default",
        storage: handle.storage.db,
        ingress: { submitMessage, submitApprovalDecision: vi.fn(() => false) },
        control,
      });

      await handler({
        sender: {
          sender_id: { open_id: "ou_sender" },
          sender_type: "user",
        },
        message: {
          message_id: "om_thread_stop_1",
          parent_id: "om_parent_1",
          thread_id: "omt_thread_1",
          chat_id: "oc_chat_1",
          chat_type: "p2p",
          message_type: "text",
          create_time: "1774569600000",
          content: JSON.stringify({ text: "/stop" }),
        },
      });

      expect(submitMessage).not.toHaveBeenCalled();
      expect(control.stopSession).toHaveBeenCalledExactlyOnceWith({
        sessionId: "sess_thread_1",
        actor: "lark:default:ou_sender",
        sourceKind: "command",
        requestScope: "session",
        reasonText: "stop requested from lark command",
      });
      expect(control.stopConversation).not.toHaveBeenCalled();
    });
  });

  test("routes /stop inside a task thread to the source task session", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);
      handle.storage.sqlite.exec(`
        INSERT INTO sessions (id, conversation_id, branch_id, owner_agent_id, purpose, status, created_at, updated_at)
        VALUES ('sess_task_1', 'conv_main', 'branch_main', 'agent_main', 'task', 'active', '2026-03-27T00:00:03.000Z', '2026-03-27T00:00:04.000Z');

        INSERT INTO cron_jobs (
          id, owner_agent_id, target_conversation_id, target_branch_id, schedule_kind, schedule_value,
          payload_json, created_at, updated_at
        ) VALUES (
          'cron_1', 'agent_main', 'conv_main', 'branch_main', 'cron', '0 * * * *',
          '{}', '2026-03-27T00:00:03.000Z', '2026-03-27T00:00:04.000Z'
        );

        INSERT INTO task_runs (
          id, run_type, owner_agent_id, conversation_id, branch_id, cron_job_id, execution_session_id,
          status, priority, attempt, description, input_json, started_at
        ) VALUES (
          'task_1', 'cron', 'agent_main', 'conv_main', 'branch_main', 'cron_1', 'sess_task_1',
          'running', 0, 1, 'Existing task thread', '{}', '2026-03-27T00:00:03.000Z'
        );
      `);
      new LarkObjectBindingsRepo(handle.storage.db).upsert({
        id: "binding_task_card",
        channelInstallationId: "default",
        conversationId: "conv_main",
        branchId: "branch_main",
        internalObjectKind: "run_card",
        internalObjectId: "task:task_1",
        larkMessageId: "om_task_card_1",
        larkCardId: "card_task_1",
        threadRootMessageId: "omt_task_thread_1",
        metadataJson: JSON.stringify({
          sessionId: "sess_task_1",
          taskRunId: "task_1",
          taskRunType: "cron",
        }),
      });

      const submitMessage = vi.fn(async () => ({ status: "started" as const }));
      const control = {
        stopSession: vi.fn(() => ({
          accepted: true,
          sessionId: "sess_task_1",
          runIds: ["run_task_1"],
          conversationId: "conv_main",
        })),
        stopConversation: vi.fn(),
      } as unknown as RuntimeControlService;
      const handler = createLarkMessageReceiveHandler({
        installationId: "default",
        storage: handle.storage.db,
        ingress: { submitMessage, submitApprovalDecision: vi.fn(() => false) },
        control,
      });

      await handler({
        sender: {
          sender_id: { open_id: "ou_sender" },
          sender_type: "user",
        },
        message: {
          message_id: "om_task_thread_stop_1",
          parent_id: "om_user_reply_1",
          thread_id: "omt_task_thread_1",
          chat_id: "oc_chat_1",
          chat_type: "p2p",
          message_type: "text",
          create_time: "1774569600000",
          content: JSON.stringify({ text: "/stop" }),
        },
      });

      expect(submitMessage).not.toHaveBeenCalled();
      expect(control.stopSession).toHaveBeenCalledExactlyOnceWith({
        sessionId: "sess_task_1",
        actor: "lark:default:ou_sender",
        sourceKind: "command",
        requestScope: "session",
        reasonText: "stop requested from lark command",
      });
      expect(control.stopConversation).not.toHaveBeenCalled();
    });
  });

  test("routes /status inside an ordinary thread back into the same thread", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);
      handle.storage.sqlite.exec(`
        INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, external_branch_id, parent_branch_id, created_at, updated_at)
        VALUES ('branch_thread_1', 'conv_main', 'dm_thread', 'thread:omt_thread_1', 'omt_thread_1', 'branch_main', '2026-03-27T00:00:03.000Z', '2026-03-27T00:00:03.000Z');

        INSERT INTO sessions (id, conversation_id, branch_id, owner_agent_id, purpose, status, created_at, updated_at)
        VALUES ('sess_thread_1', 'conv_main', 'branch_thread_1', 'agent_main', 'chat', 'active', '2026-03-27T00:00:03.000Z', '2026-03-27T00:00:04.000Z');
      `);
      new ChannelSurfacesRepo(handle.storage.db).upsert({
        id: "surface_thread_1",
        channelType: "lark",
        channelInstallationId: "default",
        conversationId: "conv_main",
        branchId: "branch_thread_1",
        surfaceKey: buildLarkThreadSurfaceKey("oc_chat_1", "omt_thread_1"),
        surfaceObjectJson: JSON.stringify({
          chat_id: "oc_chat_1",
          thread_id: "omt_thread_1",
          reply_to_message_id: "om_parent_1",
        }),
      });

      const submitMessage = vi.fn(async () => ({ status: "started" as const }));
      const reply = vi.fn(async () => ({ data: { message_id: "om_status_thread_1" } }));
      const status = {
        getConversationStatus: vi.fn(() => ({
          conversationId: "conv_main",
          sessionId: "sess_thread_1",
          model: {
            configuredModelId: "openrouter-gpt5.4",
            providerId: "openrouter",
            upstreamModelId: "openai/gpt-5.4",
            modelApi: "openai-responses",
            supportsReasoning: true,
            source: "scenario_default" as const,
          },
          sessionUsage: {
            input: 1,
            output: 2,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 3,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          latestTurnUsage: null,
          latestTurnErrorMessage: null,
          activeRuns: [],
          pendingApprovals: [],
        })),
      } satisfies Pick<RuntimeStatusService, "getConversationStatus">;
      const clients = {
        getOrCreate: vi.fn(() => ({
          sdk: {
            im: {
              message: {
                create: vi.fn(),
                reply,
              },
            },
          },
        })),
      } as unknown as { getOrCreate(installationId: string): LarkSdkClient };

      const handler = createLarkMessageReceiveHandler({
        installationId: "default",
        storage: handle.storage.db,
        ingress: { submitMessage, submitApprovalDecision: vi.fn(() => false) },
        control: new RuntimeControlService(new SessionRunAbortRegistry()),
        status: status as unknown as RuntimeStatusService,
        clients,
      });

      await handler({
        sender: {
          sender_id: { open_id: "ou_sender" },
          sender_type: "user",
        },
        message: {
          message_id: "om_thread_status_1",
          parent_id: "om_parent_1",
          thread_id: "omt_thread_1",
          chat_id: "oc_chat_1",
          chat_type: "p2p",
          message_type: "text",
          create_time: "1774569600000",
          content: JSON.stringify({ text: "/status" }),
        },
      });

      expect(submitMessage).not.toHaveBeenCalled();
      expect(status.getConversationStatus).toHaveBeenCalledExactlyOnceWith({
        conversationId: "conv_main",
        sessionId: "sess_thread_1",
        scenario: "chat",
      });
      expect(reply).toHaveBeenCalledOnce();
      expect(
        (reply as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0],
      ).toMatchObject({
        path: { message_id: "om_parent_1" },
        data: {
          msg_type: "interactive",
          reply_in_thread: true,
        },
      });
    });
  });

  test("routes /status inside a task thread back to the stored thread anchor when parent_id is missing", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);
      handle.storage.sqlite.exec(`
        INSERT INTO sessions (id, conversation_id, branch_id, owner_agent_id, purpose, status, created_at, updated_at)
        VALUES ('sess_task_1', 'conv_main', 'branch_main', 'agent_main', 'task', 'active', '2026-03-27T00:00:03.000Z', '2026-03-27T00:00:04.000Z');

        INSERT INTO cron_jobs (
          id, owner_agent_id, target_conversation_id, target_branch_id, schedule_kind, schedule_value,
          payload_json, created_at, updated_at
        ) VALUES (
          'cron_1', 'agent_main', 'conv_main', 'branch_main', 'cron', '0 * * * *',
          '{}', '2026-03-27T00:00:03.000Z', '2026-03-27T00:00:04.000Z'
        );

        INSERT INTO task_runs (
          id, run_type, owner_agent_id, conversation_id, branch_id, cron_job_id, execution_session_id,
          status, priority, attempt, description, input_json, started_at
        ) VALUES (
          'task_1', 'cron', 'agent_main', 'conv_main', 'branch_main', 'cron_1', 'sess_task_1',
          'running', 0, 1, 'Existing task thread', '{}', '2026-03-27T00:00:03.000Z'
        );
      `);
      new LarkObjectBindingsRepo(handle.storage.db).upsert({
        id: "binding_task_card",
        channelInstallationId: "default",
        conversationId: "conv_main",
        branchId: "branch_main",
        internalObjectKind: "run_card",
        internalObjectId: "task:task_1",
        larkMessageId: "om_task_card_1",
        larkCardId: "card_task_1",
        threadRootMessageId: "omt_task_thread_1",
        metadataJson: JSON.stringify({
          sessionId: "sess_task_1",
          taskRunId: "task_1",
          taskRunType: "cron",
        }),
      });

      const submitMessage = vi.fn(async () => ({ status: "started" as const }));
      const reply = vi.fn(async () => ({ data: { message_id: "om_task_status_thread_1" } }));
      const status = {
        getConversationStatus: vi.fn(() => ({
          conversationId: "conv_main",
          sessionId: "sess_task_1",
          model: {
            configuredModelId: "openrouter-gpt5.4",
            providerId: "openrouter",
            upstreamModelId: "openai/gpt-5.4",
            modelApi: "openai-responses",
            supportsReasoning: true,
            source: "scenario_default" as const,
          },
          sessionUsage: {
            input: 1,
            output: 2,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 3,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          latestTurnUsage: null,
          latestTurnErrorMessage: null,
          activeRuns: [],
          pendingApprovals: [],
        })),
      } satisfies Pick<RuntimeStatusService, "getConversationStatus">;
      const clients = {
        getOrCreate: vi.fn(() => ({
          sdk: {
            im: {
              message: {
                create: vi.fn(),
                reply,
              },
            },
          },
        })),
      } as unknown as { getOrCreate(installationId: string): LarkSdkClient };

      const handler = createLarkMessageReceiveHandler({
        installationId: "default",
        storage: handle.storage.db,
        ingress: { submitMessage, submitApprovalDecision: vi.fn(() => false) },
        control: new RuntimeControlService(new SessionRunAbortRegistry()),
        status: status as unknown as RuntimeStatusService,
        clients,
      });

      await handler({
        sender: {
          sender_id: { open_id: "ou_sender" },
          sender_type: "user",
        },
        message: {
          message_id: "om_task_thread_status_1",
          chat_id: "oc_chat_1",
          chat_type: "p2p",
          thread_id: "omt_task_thread_1",
          message_type: "text",
          create_time: "1774569600000",
          content: JSON.stringify({ text: "/status" }),
        },
      });

      expect(submitMessage).not.toHaveBeenCalled();
      expect(status.getConversationStatus).toHaveBeenCalledExactlyOnceWith({
        conversationId: "conv_main",
        sessionId: "sess_task_1",
        scenario: "task",
      });
      expect(reply).toHaveBeenCalledOnce();
      expect(
        (reply as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0],
      ).toMatchObject({
        path: { message_id: "om_task_card_1" },
        data: {
          msg_type: "interactive",
          reply_in_thread: true,
        },
      });
    });
  });

  test("routes /status to the status service and sends a direct lark text reply", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);
      const surfacesRepo = new ChannelSurfacesRepo(handle.storage.db);
      surfacesRepo.upsert({
        id: "surface_1",
        channelType: "lark",
        channelInstallationId: "default",
        conversationId: "conv_main",
        branchId: "branch_main",
        surfaceKey: buildLarkChatSurfaceKey("oc_chat_1"),
        surfaceObjectJson: JSON.stringify({ chat_id: "oc_chat_1" }),
      });

      const submitMessage = vi.fn(async () => ({ status: "started" as const }));
      const create = vi.fn(async () => ({ data: { message_id: "om_status_1" } }));
      const status = {
        getConversationStatus: vi.fn(() => ({
          conversationId: "conv_main",
          sessionId: "sess_chat_1",
          model: {
            configuredModelId: "openrouter-gpt5.4",
            providerId: "openrouter",
            upstreamModelId: "openai/gpt-5.4",
            modelApi: "openai-responses",
            supportsReasoning: true,
            source: "scenario_default" as const,
          },
          sessionUsage: {
            input: 100,
            output: 20,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 120,
            cost: {
              input: 0.001,
              output: 0.002,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0.003,
            },
          },
          latestTurnUsage: null,
          latestTurnErrorMessage: null,
          activeRuns: [],
          pendingApprovals: [],
        })),
      } satisfies Pick<RuntimeStatusService, "getConversationStatus">;
      const clients = {
        getOrCreate: vi.fn(() => ({
          sdk: {
            im: {
              message: {
                create,
              },
            },
          },
        })),
      } as unknown as { getOrCreate(installationId: string): LarkSdkClient };

      const handler = createLarkMessageReceiveHandler({
        installationId: "default",
        storage: handle.storage.db,
        ingress: { submitMessage, submitApprovalDecision: vi.fn(() => false) },
        control: new RuntimeControlService(new SessionRunAbortRegistry()),
        status: status as unknown as RuntimeStatusService,
        clients,
      });

      await handler(makeTextEvent("/status"));

      expect(submitMessage).not.toHaveBeenCalled();
      expect(status.getConversationStatus).toHaveBeenCalledExactlyOnceWith({
        conversationId: "conv_main",
        sessionId: "sess_chat_1",
        scenario: "chat",
      });
      expect(create).toHaveBeenCalledOnce();
      const firstCall = create.mock.calls[0] as [Record<string, unknown>] | undefined;
      expect(firstCall?.[0]).toMatchObject({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: "oc_chat_1",
          msg_type: "interactive",
        },
      });
      const content = JSON.parse(
        String((firstCall?.[0] as { data?: { content?: string } } | undefined)?.data?.content),
      ) as {
        header?: { title?: { content?: string } };
        body?: { elements?: Array<{ tag?: string; content?: string }> };
      };
      expect(content.header?.title?.content).toBe("当前状态");
      const markdown = (content.body?.elements ?? [])
        .filter((element) => element.tag === "markdown")
        .map((element) => element.content ?? "")
        .join("\n");
      expect(markdown).toContain("openrouter-gpt5.4");
      expect(markdown).toContain("**版本**");
    });
  });

  test("routes /help to a markdown help card with slash command guidance", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);
      const surfacesRepo = new ChannelSurfacesRepo(handle.storage.db);
      surfacesRepo.upsert({
        id: "surface_help_1",
        channelType: "lark",
        channelInstallationId: "default",
        conversationId: "conv_main",
        branchId: "branch_main",
        surfaceKey: buildLarkChatSurfaceKey("oc_chat_1"),
        surfaceObjectJson: JSON.stringify({ chat_id: "oc_chat_1" }),
      });

      const submitMessage = vi.fn(async () => ({ status: "started" as const }));
      const create = vi.fn(async () => ({ data: { message_id: "om_help_1" } }));
      const handler = createLarkMessageReceiveHandler({
        installationId: "default",
        storage: handle.storage.db,
        ingress: { submitMessage, submitApprovalDecision: vi.fn(() => false) },
        control: new RuntimeControlService(new SessionRunAbortRegistry()),
        clients: {
          getOrCreate: vi.fn(() => ({
            sdk: {
              im: {
                message: {
                  create,
                  reply: vi.fn(),
                },
              },
            },
          })) as unknown as (installationId: string) => LarkSdkClient,
        },
      });

      await handler(makeTextEvent("/help"));

      expect(submitMessage).not.toHaveBeenCalled();
      expect(create).toHaveBeenCalledTimes(1);
      const firstCall = create.mock.calls[0] as [Record<string, unknown>] | undefined;
      expect(firstCall?.[0]).toMatchObject({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: "oc_chat_1",
          msg_type: "interactive",
        },
      });
      const content = JSON.parse(
        String((firstCall?.[0] as { data?: { content?: string } } | undefined)?.data?.content),
      ) as {
        header?: { title?: { content?: string } };
        body?: { elements?: Array<{ tag?: string; content?: string }> };
      };
      expect(content.header?.title?.content).toBe("Slash Commands");
      const markdown = (content.body?.elements ?? [])
        .filter((element) => element.tag === "markdown")
        .map((element) => element.content ?? "")
        .join("\n");
      expect(markdown).toBe(
        [
          "### Slash Commands",
          "- /help — Show this help message.",
          "- /status — Show the current conversation status, model, usage, and active runs.",
          "- /model — Open the model switch card for the current conversation.",
          "- /stop — Stop the current conversation or session.",
        ].join("\n"),
      );
    });
  });
});
