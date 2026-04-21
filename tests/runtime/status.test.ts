import { afterEach, describe, expect, test, vi } from "vitest";
import { ProviderRegistry } from "@/src/agent/llm/provider-registry.js";
import type { AppConfig } from "@/src/config/schema.js";
import { SessionRunAbortRegistry } from "@/src/runtime/cancel.js";
import { RuntimeControlService } from "@/src/runtime/control.js";
import {
  buildConversationStatusPresentation,
  formatConversationStatusText,
  RuntimeStatusService,
} from "@/src/runtime/status.js";
import {
  createTestDatabase,
  destroyTestDatabase,
  type TestDatabaseHandle,
} from "@/tests/storage/helpers/test-db.js";

async function withHandle(fn: (handle: TestDatabaseHandle) => Promise<void>): Promise<void> {
  const handle = await createTestDatabase(import.meta.url);
  try {
    await fn(handle);
  } finally {
    await destroyTestDatabase(handle);
  }
}

const FIXED_NOW = new Date("2026-04-05T12:00:00.000Z");

function isoNowMinusDays(days: number, extraHours = 0): string {
  return new Date(
    FIXED_NOW.getTime() - days * 24 * 60 * 60 * 1000 + extraHours * 60 * 60 * 1000,
  ).toISOString();
}

afterEach(() => {
  vi.useRealTimers();
});

function createConfig(): AppConfig {
  return {
    logging: {
      level: "info",
      useColors: false,
    },
    providers: {
      openrouter: {
        api: "openai-responses",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "test-key",
      },
    },
    models: {
      catalog: [
        {
          id: "openrouter-gpt5.4",
          provider: "openrouter",
          upstreamId: "openai/gpt-5.4",
          contextWindow: 400_000,
          maxOutputTokens: 32_000,
          supportsTools: true,
          supportsVision: false,
          reasoning: { enabled: true },
        },
      ],
      scenarios: {
        chat: ["openrouter-gpt5.4"],
        compaction: ["openrouter-gpt5.4"],
        task: ["openrouter-gpt5.4"],
        thinkTankAdvisor: [],
        meditationBucket: [],
        meditationConsolidation: [],
      },
    },
    compaction: {
      reserveTokens: 60_000,
      keepRecentTokens: 40_000,
      reserveTokensFloor: 60_000,
      recentTurnsPreserve: 3,
    },
    runtime: {
      maxTurns: 60,
      approvalTimeoutMs: 180_000,
      approvalGrantTtlMs: 604_800_000,
    },
    selfHarness: {
      meditation: {
        enabled: true,
        cron: "0 0 * * *",
      },
    },
    tools: {
      web: {
        search: {
          enabled: false,
        },
        fetch: {
          enabled: false,
        },
      },
    },
    security: {
      filesystem: {
        overrideHardDenyRead: false,
        overrideHardDenyWrite: false,
        hardDenyRead: [],
        hardDenyWrite: [],
      },
      network: {
        overrideHardDenyHosts: false,
        hardDenyHosts: [],
      },
    },
    channels: {
      lark: {
        installations: {},
      },
    },
    secrets: {},
  };
}

describe("runtime status service", () => {
  test("aggregates recent 3-day session usage, active runs, and pending approvals", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);

    await withHandle(async (handle) => {
      handle.storage.sqlite.exec(`
        INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
        VALUES ('ci_1', 'lark', 'default', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

        INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
        VALUES ('conv_1', 'ci_1', 'oc_chat_1', 'dm', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

        INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
        VALUES ('branch_1', 'conv_1', 'dm_main', 'main', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

        INSERT INTO agents (id, conversation_id, kind, default_model, created_at)
        VALUES ('agent_1', 'conv_1', 'main', 'openrouter-gpt5.4', '2026-03-28T00:00:00.000Z');

        INSERT INTO sessions (
          id, conversation_id, branch_id, owner_agent_id, purpose, status,
          compact_cursor, compact_summary_usage_json, created_at, updated_at
        ) VALUES (
          'sess_chat', 'conv_1', 'branch_1', 'agent_1', 'chat', 'active',
          10,
          '{"input":1000,"output":200,"cacheRead":3000,"cacheWrite":0,"totalTokens":4200,"cost":{"input":0.01,"output":0.02,"cacheRead":0,"cacheWrite":0,"total":0.03}}',
          '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z'
        );

        INSERT INTO sessions (
          id, conversation_id, branch_id, owner_agent_id, purpose, status, created_at, updated_at
        ) VALUES (
          'sess_task', 'conv_1', 'branch_1', 'agent_1', 'task', 'active',
          '2026-03-28T00:01:00.000Z', '2026-03-28T00:01:00.000Z'
        );

        INSERT INTO messages (
          id, session_id, seq, role, message_type, visibility, provider, model, model_api, stop_reason,
          payload_json, token_input, token_output, token_cache_read, token_cache_write, token_total, usage_json, created_at
        ) VALUES
          (
            'msg_old', 'sess_chat', 11, 'assistant', 'text', 'user_visible', 'openrouter', 'openai/gpt-5.4', 'openai-responses', 'stop',
            '{"content":[{"type":"text","text":"old"}]}',
            40, 8, 4, 0, 52,
            '{"input":40,"output":8,"cacheRead":4,"cacheWrite":0,"totalTokens":52,"cost":{"input":0.0008,"output":0.0016,"cacheRead":0.00008,"cacheWrite":0,"total":0.00248}}',
            '${isoNowMinusDays(4)}'
          ),
          (
            'msg_recent', 'sess_chat', 12, 'assistant', 'text', 'user_visible', 'openrouter', 'openai/gpt-5.4', 'openai-responses', 'stop',
            '{"content":[{"type":"text","text":"hello"}]}',
            50, 10, 5, 0, 65,
            '{"input":50,"output":10,"cacheRead":5,"cacheWrite":0,"totalTokens":65,"cost":{"input":0.001,"output":0.002,"cacheRead":0.0001,"cacheWrite":0,"total":0.0031}}',
            '${isoNowMinusDays(1)}'
          );

        INSERT INTO approval_ledger (
          owner_agent_id, requested_by_session_id, requested_scope_json, approval_target, status, reason_text, created_at
        ) VALUES (
          'agent_1', 'sess_task', '{}', 'user', 'pending', 'Approval required: Write /tmp/demo.js', '2026-03-28T00:03:00.000Z'
        );

        INSERT INTO task_runs (
          id, run_type, owner_agent_id, conversation_id, branch_id, execution_session_id, status, started_at
        ) VALUES (
          'task_run_1', 'delegate', 'agent_1', 'conv_1', 'branch_1', 'sess_task', 'running', '2026-03-28T00:04:00.000Z'
        );
      `);

      const control = new RuntimeControlService(new SessionRunAbortRegistry());
      control.beginRun({
        runId: "run_chat_1",
        sessionId: "sess_chat",
        conversationId: "conv_1",
        branchId: "branch_1",
        scenario: "chat",
      });
      control.beginRun({
        runId: "run_task_1",
        sessionId: "sess_task",
        conversationId: "conv_1",
        branchId: "branch_1",
        scenario: "chat",
      });

      const service = new RuntimeStatusService({
        storage: handle.storage.db,
        control,
        models: new ProviderRegistry(createConfig()),
      });

      const snapshot = service.getConversationStatus({
        conversationId: "conv_1",
        sessionId: "sess_chat",
        scenario: "chat",
      });

      expect(snapshot.model).toMatchObject({
        configuredModelId: "openrouter-gpt5.4",
        providerId: "openrouter",
        upstreamModelId: "openai/gpt-5.4",
        modelApi: "openai-responses",
        supportsReasoning: true,
        source: "latest_assistant",
      });
      expect(snapshot.latestTurnUsage).toMatchObject({
        totalTokens: 65,
        cost: {
          total: 0.0031,
        },
      });
      expect(snapshot.sessionUsage).toMatchObject({
        totalTokens: 65,
        input: 50,
        output: 10,
        cacheRead: 5,
        cost: {
          total: 0.0031,
        },
      });
      expect(snapshot.activeRuns).toEqual([
        expect.objectContaining({
          runId: "run_chat_1",
          sessionPurpose: "chat",
          taskRunId: null,
        }),
        expect.objectContaining({
          runId: "run_task_1",
          sessionPurpose: "task",
          taskRunId: "task_run_1",
          taskRunType: "delegate",
          taskRunStatus: "running",
        }),
      ]);
      expect(snapshot.pendingApprovals).toEqual([
        expect.objectContaining({
          approvalId: 1,
          approvalTarget: "user",
        }),
      ]);

      const text = formatConversationStatusText(snapshot);
      expect(text).toContain("当前状态");
      expect(text).toContain("openrouter-gpt5.4 / openai/gpt-5.4 / openrouter / openai-responses");
      expect(text).toContain("- 最近 3 天 session");
      expect(text).not.toContain("- 当前 session 累计");
      expect(text).toContain("  总 65 / 输入 50 / 输出 10");
      expect(text).toContain("  缓存读 5 / 缓存写 0");
      expect(text).toContain("Cost $0.003100");
      expect(text).toContain("待处理授权");
      expect(text).toContain("#1 (user) Approval required: Write /tmp/demo.js");

      const presentation = buildConversationStatusPresentation(snapshot);
      expect(presentation.title).toBe("当前状态");
      expect(presentation.summary).toBe("存在活跃 run");
      expect(presentation.markdownSections.join("\n")).toContain("**版本**");
      expect(presentation.markdownSections.join("\n")).toContain("openrouter-gpt5.4");
      expect(presentation.markdownSections.join("\n")).toContain("**最近 3 天 session**");
      expect(presentation.markdownSections.join("\n")).not.toContain("**当前 session 累计**");
      expect(presentation.markdownSections.join("\n")).toContain("- 总 65 / 输入 50 / 输出 10");
      expect(presentation.markdownSections.join("\n")).toContain("- 缓存读 5 / 缓存写 0");
      expect(presentation.markdownSections.join("\n")).toContain("- Cost $0.003100");
    });
  });

  test("treats reasoning.enabled = false as reasoning disabled in status output", async () => {
    await withHandle(async (handle) => {
      const config = createConfig();
      const model = config.models.catalog[0];
      if (model == null) {
        throw new Error("expected seeded model");
      }
      model.reasoning = { enabled: false };

      handle.storage.sqlite.exec(`
        INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
        VALUES ('ci_1', 'lark', 'default', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

        INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
        VALUES ('conv_1', 'ci_1', 'oc_chat_1', 'dm', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

        INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
        VALUES ('branch_1', 'conv_1', 'dm_main', 'main', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

        INSERT INTO agents (id, conversation_id, kind, default_model, created_at)
        VALUES ('agent_1', 'conv_1', 'main', 'openrouter-gpt5.4', '2026-03-28T00:00:00.000Z');

        INSERT INTO sessions (
          id, conversation_id, branch_id, owner_agent_id, purpose, status, compact_cursor, created_at, updated_at
        ) VALUES (
          'sess_chat', 'conv_1', 'branch_1', 'agent_1', 'chat', 'active', 0,
          '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z'
        );
      `);

      const service = new RuntimeStatusService({
        storage: handle.storage.db,
        control: new RuntimeControlService(new SessionRunAbortRegistry()),
        models: new ProviderRegistry(config),
      });

      const snapshot = service.getConversationStatus({
        conversationId: "conv_1",
        sessionId: "sess_chat",
        scenario: "chat",
      });

      expect(snapshot.model.supportsReasoning).toBe(false);
      expect(formatConversationStatusText(snapshot)).toContain("Reasoning: 不支持");
    });
  });

  test("falls back to token columns when assistant usageJson is missing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);

    await withHandle(async (handle) => {
      handle.storage.sqlite.exec(`
        INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
        VALUES ('ci_1', 'lark', 'default', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

        INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
        VALUES ('conv_1', 'ci_1', 'oc_chat_1', 'dm', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

        INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
        VALUES ('branch_1', 'conv_1', 'dm_main', 'main', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

        INSERT INTO agents (id, conversation_id, kind, default_model, created_at)
        VALUES ('agent_1', 'conv_1', 'main', 'openrouter-gpt5.4', '2026-03-28T00:00:00.000Z');

        INSERT INTO sessions (
          id, conversation_id, branch_id, owner_agent_id, purpose, status, compact_cursor, created_at, updated_at
        ) VALUES (
          'sess_chat', 'conv_1', 'branch_1', 'agent_1', 'chat', 'active', 0,
          '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z'
        );

        INSERT INTO messages (
          id, session_id, seq, role, message_type, visibility, provider, model, model_api, stop_reason,
          payload_json, token_input, token_output, token_cache_read, token_cache_write, token_total, usage_json, created_at
        ) VALUES (
          'msg_a_1', 'sess_chat', 1, 'assistant', 'text', 'user_visible', 'openrouter', 'openai/gpt-5.4', 'openai-responses', 'stop',
          '{"content":[{"type":"text","text":"hello"}]}',
          50, 10, 5, 0, 65,
          NULL,
          '${isoNowMinusDays(1)}'
        );
      `);

      const service = new RuntimeStatusService({
        storage: handle.storage.db,
        control: new RuntimeControlService(new SessionRunAbortRegistry()),
        models: new ProviderRegistry(createConfig()),
      });

      const snapshot = service.getConversationStatus({
        conversationId: "conv_1",
        sessionId: "sess_chat",
        scenario: "chat",
      });

      expect(snapshot.latestTurnUsage).toMatchObject({
        input: 50,
        output: 10,
        cacheRead: 5,
        cacheWrite: 0,
        totalTokens: 65,
        cost: {
          total: 0,
        },
      });
      expect(snapshot.sessionUsage).toMatchObject({
        input: 50,
        output: 10,
        cacheRead: 5,
        cacheWrite: 0,
        totalTokens: 65,
        cost: {
          total: 0,
        },
      });

      const text = formatConversationStatusText(snapshot);
      expect(text).toContain("- 最近 3 天 session");
      expect(text).toContain("- 最近一次回复");
      expect(text).toContain("  总 65 / 输入 50 / 输出 10");
      expect(text).toContain("Cost $0.000000");

      const presentation = buildConversationStatusPresentation(snapshot);
      expect(presentation.markdownSections.join("\n")).toContain("**最近一次回复**");
      expect(presentation.markdownSections.join("\n")).toContain("- 总 65 / 输入 50 / 输出 10");
      expect(presentation.markdownSections.join("\n")).toContain("- 缓存读 5 / 缓存写 0");
      expect(presentation.markdownSections.join("\n")).toContain("- Cost $0.000000");
    });
  });

  test("treats zero-usage error assistant rows as unknown usage in status output", async () => {
    await withHandle(async (handle) => {
      handle.storage.sqlite.exec(`
        INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
        VALUES ('ci_1', 'lark', 'default', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

        INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
        VALUES ('conv_1', 'ci_1', 'oc_chat_1', 'dm', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

        INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
        VALUES ('branch_1', 'conv_1', 'dm_main', 'main', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

        INSERT INTO agents (id, conversation_id, kind, default_model, created_at)
        VALUES ('agent_1', 'conv_1', 'main', 'openrouter-gpt5.4', '2026-03-28T00:00:00.000Z');

        INSERT INTO sessions (
          id, conversation_id, branch_id, owner_agent_id, purpose, status, compact_cursor, created_at, updated_at
        ) VALUES (
          'sess_chat', 'conv_1', 'branch_1', 'agent_1', 'chat', 'active', 0,
          '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z'
        );

        INSERT INTO messages (
          id, session_id, seq, role, message_type, visibility, provider, model, model_api, stop_reason, error_message,
          payload_json, token_input, token_output, token_cache_read, token_cache_write, token_total, usage_json, created_at
        ) VALUES (
          'msg_a_1', 'sess_chat', 1, 'assistant', 'text', 'user_visible', 'openrouter', 'openai/gpt-5.4', 'openai-responses', 'error', 'terminated',
          '{"content":[{"type":"text","text":"partial answer"}]}',
          0, 0, 0, 0, 0,
          '{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}}',
          '2026-03-28T00:02:00.000Z'
        );
      `);

      const service = new RuntimeStatusService({
        storage: handle.storage.db,
        control: new RuntimeControlService(new SessionRunAbortRegistry()),
        models: new ProviderRegistry(createConfig()),
      });

      const snapshot = service.getConversationStatus({
        conversationId: "conv_1",
        sessionId: "sess_chat",
        scenario: "chat",
      });

      expect(snapshot.latestTurnUsage).toBeNull();
      expect(snapshot.latestTurnErrorMessage).toBe("terminated");
      expect(snapshot.sessionUsage).toBeNull();

      const text = formatConversationStatusText(snapshot);
      expect(text).toContain("- 最近一次回复: 出错（terminated），usage 无法统计。");

      const presentation = buildConversationStatusPresentation(snapshot);
      expect(presentation.markdownSections.join("\n")).toContain(
        "- 最近一次回复: 出错（terminated），usage 无法统计。",
      );
    });
  });
});
