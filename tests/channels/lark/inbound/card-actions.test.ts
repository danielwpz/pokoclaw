import { describe, expect, test, vi } from "vitest";
import type { LarkSdkClient } from "@/src/channels/lark/client.js";
import {
  createLarkCardActionHandler,
  createLarkInboundRuntime,
  createLarkMessageReceiveHandler,
} from "@/src/channels/lark/inbound.js";
import { SessionRunAbortRegistry } from "@/src/runtime/cancel.js";
import { RuntimeControlService } from "@/src/runtime/control.js";
import { makeTextEvent, seedFixture, withHandle } from "./fixtures.js";

describe("lark card actions", () => {
  test("routes a2ui callbacks before built-in card actions", async () => {
    const handleCardAction = vi.fn(async () => ({
      toast: {
        type: "success",
        content: "a2ui handled",
      },
    }));
    const submitApprovalDecision = vi.fn(() => true);
    const handler = createLarkCardActionHandler({
      installationId: "default",
      ingress: {
        submitMessage: vi.fn(async () => ({ status: "started" as const })),
        submitApprovalDecision,
      },
      control: {} as RuntimeControlService,
      a2uiCallbacks: {
        handleCardAction,
      },
    });

    const payload = {
      action: {
        value: {
          __a2ui_lark: "v0_8",
          surfaceId: "quiz",
          sourceComponentId: "submit",
          actionName: "submit_answer",
        },
      },
    };
    const result = await handler(payload);

    expect(handleCardAction).toHaveBeenCalledExactlyOnceWith({
      installationId: "default",
      payload,
    });
    expect(submitApprovalDecision).not.toHaveBeenCalled();
    expect(result).toEqual({
      toast: {
        type: "success",
        content: "a2ui handled",
      },
    });
  });

  test("ignores unsupported card actions", async () => {
    const submitApprovalDecision = vi.fn(() => true);
    const handler = createLarkCardActionHandler({
      installationId: "default",
      ingress: {
        submitMessage: vi.fn(async () => ({ status: "started" as const })),
        submitApprovalDecision,
      },
      control: {} as RuntimeControlService,
    });

    const result = await handler({
      action: {
        value: {
          action: "unsupported_action",
        },
      },
      operator: {
        open_id: "ou_sender",
      },
    });

    expect(submitApprovalDecision).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  test("routes stop button callbacks to control service", async () => {
    const control = {
      stopRun: vi.fn(() => ({
        accepted: true,
        runId: "run_123",
        sessionId: "sess_123",
        conversationId: "conv_123",
      })),
    } as unknown as RuntimeControlService;

    const handler = createLarkCardActionHandler({
      installationId: "default",
      ingress: {
        submitMessage: vi.fn(async () => ({ status: "started" as const })),
        submitApprovalDecision: vi.fn(() => false),
      },
      control,
    });

    const result = await handler({
      action: {
        value: {
          action: "stop_run",
          runId: "run_123",
        },
      },
      operator: {
        open_id: "ou_sender",
      },
    });

    expect(control.stopRun).toHaveBeenCalledExactlyOnceWith({
      runId: "run_123",
      actor: "lark:default:ou_sender",
      sourceKind: "button",
      requestScope: "run",
      reasonText: "stop requested from lark card action",
    });
    expect(result).toEqual({
      toast: {
        type: "success",
        content: "正在停止...",
      },
    });
  });

  test("returns an error toast when approval callbacks are missing approvalId", async () => {
    const submitApprovalDecision = vi.fn(() => true);
    const handler = createLarkCardActionHandler({
      installationId: "default",
      ingress: {
        submitMessage: vi.fn(async () => ({ status: "started" as const })),
        submitApprovalDecision,
      },
      control: {} as RuntimeControlService,
    });

    const result = await handler({
      action: {
        value: {
          action: "approve_permission",
          grantTtl: "one_day",
        },
      },
      operator: {
        open_id: "ou_sender",
      },
    });

    expect(submitApprovalDecision).not.toHaveBeenCalled();
    expect(result).toEqual({
      toast: {
        type: "error",
        content: "无法识别授权请求",
      },
    });
  });

  test("routes approve subagent creation callbacks to orchestration handler", async () => {
    const approve = vi.fn(async () => ({
      outcome: "created" as const,
      request: {} as never,
      externalChatId: "chat_sub_1",
      shareLink: "https://example.com/subagent-1",
    }));
    const deny = vi.fn();
    const handler = createLarkCardActionHandler({
      installationId: "default",
      ingress: {
        submitMessage: vi.fn(async () => ({ status: "started" as const })),
        submitApprovalDecision: vi.fn(() => false),
      },
      control: {} as RuntimeControlService,
      subagentRequests: {
        approve,
        deny,
      },
    });

    const result = await handler({
      action: {
        value: {
          action: "approve_subagent_creation",
          requestId: "req_sub_1",
        },
      },
      operator: {
        open_id: "ou_sender",
      },
    });

    expect(approve).toHaveBeenCalledExactlyOnceWith("req_sub_1");
    expect(deny).not.toHaveBeenCalled();
    expect(result).toEqual({
      toast: {
        type: "success",
        content: "SubAgent 已创建",
      },
    });
  });

  test("routes deny subagent creation callbacks to orchestration handler", async () => {
    const approve = vi.fn(async () => ({
      outcome: "created" as const,
      request: {} as never,
      externalChatId: "chat_sub_1",
      shareLink: "https://example.com/subagent-1",
    }));
    const deny = vi.fn(() => ({
      outcome: "denied" as const,
      request: {} as never,
      externalChatId: null,
      shareLink: null,
    }));
    const handler = createLarkCardActionHandler({
      installationId: "default",
      ingress: {
        submitMessage: vi.fn(async () => ({ status: "started" as const })),
        submitApprovalDecision: vi.fn(() => false),
      },
      control: {} as RuntimeControlService,
      subagentRequests: {
        approve,
        deny,
      },
    });

    const result = await handler({
      action: {
        value: {
          action: "deny_subagent_creation",
          requestId: "req_sub_2",
        },
      },
      operator: {
        open_id: "ou_sender",
      },
    });

    expect(approve).not.toHaveBeenCalled();
    expect(deny).toHaveBeenCalledExactlyOnceWith("req_sub_2");
    expect(result).toEqual({
      toast: {
        type: "info",
        content: "已取消创建",
      },
    });
  });

  test("treats duplicate approve subagent creation callbacks as info instead of failure", async () => {
    const approve = vi.fn(async () => ({
      outcome: "already_created" as const,
      request: {} as never,
      externalChatId: "chat_sub_1",
      shareLink: null,
    }));
    const handler = createLarkCardActionHandler({
      installationId: "default",
      ingress: {
        submitMessage: vi.fn(async () => ({ status: "started" as const })),
        submitApprovalDecision: vi.fn(() => false),
      },
      control: {} as RuntimeControlService,
      subagentRequests: {
        approve,
        deny: vi.fn(),
      },
    });

    const result = await handler({
      action: {
        value: {
          action: "approve_subagent_creation",
          requestId: "req_sub_dup",
        },
      },
      operator: {
        open_id: "ou_sender",
      },
    });

    expect(result).toEqual({
      toast: {
        type: "info",
        content: "SubAgent 已创建",
      },
    });
  });

  test("treats duplicate deny subagent creation callbacks as info instead of failure", async () => {
    const deny = vi.fn(() => ({
      outcome: "already_denied" as const,
      request: {} as never,
      externalChatId: null,
      shareLink: null,
    }));
    const handler = createLarkCardActionHandler({
      installationId: "default",
      ingress: {
        submitMessage: vi.fn(async () => ({ status: "started" as const })),
        submitApprovalDecision: vi.fn(() => false),
      },
      control: {} as RuntimeControlService,
      subagentRequests: {
        approve: vi.fn(async () => ({
          outcome: "created" as const,
          request: {} as never,
          externalChatId: "chat_sub_1",
          shareLink: null,
        })),
        deny,
      },
    });

    const result = await handler({
      action: {
        value: {
          action: "deny_subagent_creation",
          requestId: "req_sub_dup",
        },
      },
      operator: {
        open_id: "ou_sender",
      },
    });

    expect(result).toEqual({
      toast: {
        type: "info",
        content: "该请求已取消",
      },
    });
  });

  test("routes one-day approval callbacks to runtime ingress", async () => {
    const submitApprovalDecision = vi.fn(
      (_input: {
        approvalId: number;
        decision: "approve" | "deny";
        actor: string;
        rawInput?: string | null;
        grantedBy?: "user" | "main_agent";
        expiresAt?: Date | null;
      }) => true,
    );
    const handler = createLarkCardActionHandler({
      installationId: "default",
      ingress: {
        submitMessage: vi.fn(async () => ({ status: "started" as const })),
        submitApprovalDecision,
      },
      control: {} as RuntimeControlService,
    });

    const before = Date.now();
    const result = await handler({
      action: {
        value: {
          action: "approve_permission",
          approvalId: 123,
          grantTtl: "one_day",
        },
      },
      operator: {
        open_id: "ou_sender",
      },
    });
    const after = Date.now();

    expect(submitApprovalDecision).toHaveBeenCalledTimes(1);
    const call = submitApprovalDecision.mock.calls[0];
    expect(call).toBeDefined();
    if (call == null) {
      throw new Error("Expected approval decision call");
    }
    const input = call[0];
    expect(input).toMatchObject({
      approvalId: 123,
      decision: "approve",
      actor: "lark:default:ou_sender",
      rawInput: "approve_1d",
      grantedBy: "user",
    });
    expect(input.expiresAt).toBeInstanceOf(Date);
    expect(input.expiresAt?.getTime()).toBeGreaterThanOrEqual(before + 24 * 60 * 60 * 1000 - 1000);
    expect(input.expiresAt?.getTime()).toBeLessThanOrEqual(after + 24 * 60 * 60 * 1000 + 1000);
    expect(result).toEqual({
      toast: {
        type: "success",
        content: "已允许 1天",
      },
    });
  });

  test("routes permanent approval callbacks to runtime ingress", async () => {
    const submitApprovalDecision = vi.fn(() => true);
    const handler = createLarkCardActionHandler({
      installationId: "default",
      ingress: {
        submitMessage: vi.fn(async () => ({ status: "started" as const })),
        submitApprovalDecision,
      },
      control: {} as RuntimeControlService,
    });

    const result = await handler({
      action: {
        value: {
          action: "approve_permission",
          approvalId: 456,
          grantTtl: "permanent",
        },
      },
      operator: {
        open_id: "ou_sender",
      },
    });

    expect(submitApprovalDecision).toHaveBeenCalledExactlyOnceWith({
      approvalId: 456,
      decision: "approve",
      actor: "lark:default:ou_sender",
      rawInput: "approve_permanent",
      grantedBy: "user",
      expiresAt: null,
    });
    expect(result).toEqual({
      toast: {
        type: "success",
        content: "已允许 永久",
      },
    });
  });

  test("routes deny approval callbacks to runtime ingress", async () => {
    const submitApprovalDecision = vi.fn(() => true);
    const handler = createLarkCardActionHandler({
      installationId: "default",
      ingress: {
        submitMessage: vi.fn(async () => ({ status: "started" as const })),
        submitApprovalDecision,
      },
      control: {} as RuntimeControlService,
    });

    const result = await handler({
      action: {
        value: {
          action: "deny_permission",
          approvalId: 789,
        },
      },
      operator: {
        open_id: "ou_sender",
      },
    });

    expect(submitApprovalDecision).toHaveBeenCalledExactlyOnceWith({
      approvalId: 789,
      decision: "deny",
      actor: "lark:default:ou_sender",
      rawInput: "deny",
      grantedBy: "user",
    });
    expect(result).toEqual({
      toast: {
        type: "error",
        content: "已拒绝",
      },
    });
  });

  test("returns an info toast when the approval request is no longer pending", async () => {
    const submitApprovalDecision = vi.fn(() => false);
    const handler = createLarkCardActionHandler({
      installationId: "default",
      ingress: {
        submitMessage: vi.fn(async () => ({ status: "started" as const })),
        submitApprovalDecision,
      },
      control: {} as RuntimeControlService,
    });

    const result = await handler({
      action: {
        value: {
          action: "approve_permission",
          approvalId: 123,
          grantTtl: "permanent",
        },
      },
      operator: {
        open_id: "ou_sender",
      },
    });

    expect(submitApprovalDecision).toHaveBeenCalledExactlyOnceWith({
      approvalId: 123,
      decision: "approve",
      actor: "lark:default:ou_sender",
      rawInput: "approve_permanent",
      grantedBy: "user",
      expiresAt: null,
    });
    expect(result).toEqual({
      toast: {
        type: "info",
        content: "该授权请求已结束或无法处理",
      },
    });
  });

  test("forwards modelSwitch through lark inbound runtime so /model works end-to-end", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);
      type InboundDispatcher = {
        invoke(data: unknown, params?: { needCheck?: boolean }): Promise<unknown>;
      };
      const dispatchers: InboundDispatcher[] = [];
      const wsClose = vi.fn();
      const messageCreate = vi.fn(async () => ({}));
      const modelSwitch = {
        getOverview: vi.fn(() => ({
          models: [
            {
              index: 1,
              modelId: "gpt5",
              providerId: "main",
              upstreamModelId: "openai/gpt-5",
              supportsTools: true,
              supportsVision: false,
              supportsReasoning: true,
            },
          ],
          scenarios: [
            {
              scenario: "chat",
              currentModelId: "gpt5",
              configuredModelIds: ["gpt5"],
            },
          ],
        })),
      };
      const runtime = createLarkInboundRuntime({
        installations: [
          {
            installationId: "default",
            appId: "cli_123",
            appSecret: "secret_123",
            config: {
              enabled: true,
              appId: "cli_123",
              appSecret: "secret_123",
              connectionMode: "websocket",
            },
          },
        ],
        storage: handle.storage.db,
        ingress: {
          submitMessage: vi.fn(async () => ({ status: "started" as const })),
          submitApprovalDecision: vi.fn(() => false),
        },
        control: new RuntimeControlService(new SessionRunAbortRegistry()),
        modelSwitch: modelSwitch as never,
        clients: {
          getOrCreate: () =>
            ({
              sdk: {
                im: {
                  message: {
                    create: messageCreate,
                    reply: vi.fn(async () => ({})),
                  },
                },
              },
            }) as unknown as LarkSdkClient,
        },
        wsClientFactory: () =>
          ({
            start: ({ eventDispatcher }: { eventDispatcher: InboundDispatcher }) => {
              dispatchers.push(eventDispatcher);
            },
            close: wsClose,
          }) as never,
      });

      runtime.start();
      const activeDispatcher = dispatchers.at(0);
      if (activeDispatcher == null) {
        throw new Error("expected lark inbound runtime to install an event dispatcher");
      }
      await activeDispatcher.invoke(
        {
          schema: "2.0",
          header: {
            event_type: "im.message.receive_v1",
          },
          event: makeTextEvent("/model"),
        },
        { needCheck: false },
      );

      expect(modelSwitch.getOverview).toHaveBeenCalledTimes(1);
      expect(messageCreate).toHaveBeenCalledTimes(1);

      await runtime.shutdown();
      expect(wsClose).toHaveBeenCalledOnce();
    });
  });

  test("routes /model to the model switch service and sends an interactive card", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);
      const submitMessage = vi.fn(async () => ({ status: "started" as const }));
      const messageCreate = vi.fn(async () => ({}));
      const modelSwitch = {
        getOverview: vi.fn(() => ({
          models: [
            {
              index: 1,
              modelId: "gpt5",
              providerId: "main",
              upstreamModelId: "openai/gpt-5",
              supportsTools: true,
              supportsVision: false,
              supportsReasoning: true,
            },
          ],
          scenarios: [
            {
              scenario: "chat",
              currentModelId: "gpt5",
              configuredModelIds: ["gpt5"],
            },
          ],
        })),
      };
      const handler = createLarkMessageReceiveHandler({
        installationId: "default",
        storage: handle.storage.db,
        ingress: { submitMessage, submitApprovalDecision: vi.fn(() => false) },
        control: new RuntimeControlService(new SessionRunAbortRegistry()),
        modelSwitch: modelSwitch as never,
        clients: {
          getOrCreate: () =>
            ({
              sdk: {
                im: {
                  message: {
                    create: messageCreate,
                    reply: vi.fn(async () => ({})),
                  },
                },
              },
            }) as unknown as LarkSdkClient,
        },
      });

      await handler(makeTextEvent("/model"));

      expect(submitMessage).not.toHaveBeenCalled();
      expect(modelSwitch.getOverview).toHaveBeenCalledTimes(1);
      expect(messageCreate).toHaveBeenCalledTimes(1);
      const firstCall = messageCreate.mock.calls.at(0) as
        | [
            {
              data?: {
                msg_type?: string;
                content?: string;
              };
            },
          ]
        | undefined;
      const payload = firstCall?.[0];
      expect(payload?.data?.msg_type).toBe("interactive");
      const content = JSON.parse(String(payload?.data?.content)) as {
        header?: { title?: { content?: string } };
      };
      expect(content.header?.title?.content).toBe("模型切换");
    });
  });

  test("returns an updated card when selecting a scenario from the model switch card", async () => {
    const modelSwitch = {
      getOverview: vi.fn(() => ({
        models: [
          {
            index: 1,
            modelId: "gpt5",
            providerId: "main",
            upstreamModelId: "openai/gpt-5",
            supportsTools: true,
            supportsVision: false,
            supportsReasoning: true,
          },
        ],
        scenarios: [
          {
            scenario: "chat",
            currentModelId: "gpt5",
            configuredModelIds: ["gpt5"],
          },
        ],
      })),
      switchScenarioModel: vi.fn(),
    };
    const handler = createLarkCardActionHandler({
      installationId: "default",
      ingress: {
        submitMessage: vi.fn(async () => ({ status: "started" as const })),
        submitApprovalDecision: vi.fn(() => false),
      },
      control: {} as RuntimeControlService,
      modelSwitch: modelSwitch as never,
    });

    const result = await handler({
      action: {
        value: {
          action: "model_switch_select_scenario",
          scenario: "chat",
        },
      },
      operator: {
        open_id: "ou_sender",
      },
    });

    expect(modelSwitch.getOverview).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      card: {
        type: "raw",
        data: {
          header: {
            title: {
              content: "模型切换",
            },
          },
        },
      },
    });
  });

  test("applies a model switch from card action and returns toast plus refreshed card", async () => {
    const modelSwitch = {
      getOverview: vi.fn(() => ({
        models: [
          {
            index: 1,
            modelId: "gpt5",
            providerId: "main",
            upstreamModelId: "openai/gpt-5",
            supportsTools: true,
            supportsVision: false,
            supportsReasoning: true,
          },
        ],
        scenarios: [
          {
            scenario: "chat",
            currentModelId: "gpt5",
            configuredModelIds: ["gpt5"],
          },
        ],
      })),
      switchScenarioModel: vi.fn(async () => ({
        scenario: "chat",
        previousModelId: "deepseek",
        nextModelId: "gpt5",
        configuredModelIds: ["gpt5", "deepseek"],
        reloaded: true,
        version: 2,
        warnings: [],
      })),
    };
    const handler = createLarkCardActionHandler({
      installationId: "default",
      ingress: {
        submitMessage: vi.fn(async () => ({ status: "started" as const })),
        submitApprovalDecision: vi.fn(() => false),
      },
      control: {} as RuntimeControlService,
      modelSwitch: modelSwitch as never,
    });

    const result = await handler({
      action: {
        value: {
          action: "model_switch_apply",
          scenario: "chat",
          modelId: "gpt5",
        },
      },
      operator: {
        open_id: "ou_sender",
      },
    });

    expect(modelSwitch.switchScenarioModel).toHaveBeenCalledExactlyOnceWith({
      scenario: "chat",
      modelId: "gpt5",
    });
    expect(result).toMatchObject({
      toast: {
        type: "success",
        content: "已切换 chat → gpt5",
      },
      card: {
        type: "raw",
        data: {
          header: {
            title: {
              content: "模型切换",
            },
          },
        },
      },
    });
  });
});
