import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import type { PiBridgeRunTurnResult } from "@/src/agent/llm/pi-bridge.js";
import { ProviderRegistry } from "@/src/agent/llm/provider-registry.js";
import { DEFAULT_CONFIG } from "@/src/config/defaults.js";
import type { AppConfig } from "@/src/config/schema.js";
import {
  filterEligiblePrivateMemoryRewrites,
  MeditationPipelineRunner,
} from "@/src/meditation/runner.js";
import { MeditationStateRepo } from "@/src/storage/repos/meditation-state.repo.js";
import {
  createTestDatabase,
  destroyTestDatabase,
  type TestDatabaseHandle,
} from "@/tests/storage/helpers/test-db.js";

function createRegistry(): ProviderRegistry {
  const config: Pick<AppConfig, "providers" | "models"> = {
    providers: {
      anthropic_main: {
        api: "anthropic-messages",
        apiKey: "anthropic-secret",
      },
      openai_main: {
        api: "openai-responses",
        apiKey: "openai-secret",
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
        {
          id: "openai_main/gpt-5-mini",
          provider: "openai_main",
          upstreamId: "gpt-5-mini",
          contextWindow: 128_000,
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
        cron: ["openai_main/gpt-5-mini"],
        meditationBucket: ["anthropic_main/claude-sonnet-4-5"],
        meditationConsolidation: ["openai_main/gpt-5-mini"],
      },
    },
  };

  return new ProviderRegistry(config);
}

function seedFixture(handle: TestDatabaseHandle): void {
  handle.storage.sqlite.exec(`
    INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
    VALUES ('ci_1', 'lark', 'acct_a', '2026-04-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z');

    INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
    VALUES ('conv_1', 'ci_1', 'chat_1', 'dm', '2026-04-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z');

    INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
    VALUES ('branch_1', 'conv_1', 'dm_main', 'main', '2026-04-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z');

    INSERT INTO agents (
      id, conversation_id, kind, display_name, description, workdir, created_at
    ) VALUES (
      'agent_sub_1', 'conv_1', 'sub', 'Atlas Frontend', 'Handles atlas-web frontend tasks.', '/repo/atlas-web', '2026-04-01T00:00:00.000Z'
    );

    INSERT INTO sessions (
      id, conversation_id, branch_id, owner_agent_id, purpose, compact_summary, created_at, updated_at
    ) VALUES (
      'sess_sub_1', 'conv_1', 'branch_1', 'agent_sub_1', 'task', 'Recent atlas summary', '2026-04-01T00:00:00.000Z', '2026-04-08T00:00:00.000Z'
    );

    INSERT INTO harness_events (
      id, event_type, run_id, session_id, conversation_id, branch_id, agent_id,
      source_kind, request_scope, created_at, actor
    ) VALUES (
      'evt_old', 'user_stop', 'run_old', 'sess_sub_1', 'conv_1', 'branch_1', 'agent_sub_1',
      'button', 'run', '2026-03-25T00:10:00.000Z', 'lark:user'
    );

    INSERT INTO harness_events (
      id, event_type, run_id, session_id, conversation_id, branch_id, agent_id,
      source_kind, request_scope, created_at, actor
    ) VALUES (
      'evt_recent', 'user_stop', 'run_recent', 'sess_sub_1', 'conv_1', 'branch_1', 'agent_sub_1',
      'button', 'run', '2026-04-07T12:00:00.000Z', 'lark:user'
    );

    INSERT INTO cron_jobs (
      id, owner_agent_id, target_conversation_id, target_branch_id,
      schedule_kind, schedule_value, payload_json, created_at, updated_at
    ) VALUES (
      'cron_1', 'agent_sub_1', 'conv_1', 'branch_1',
      'cron', '0 0 * * *', '{}', '2026-04-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z'
    );

    INSERT INTO task_runs (
      id, run_type, owner_agent_id, conversation_id, branch_id, cron_job_id, execution_session_id,
      status, description, result_summary, error_text, started_at, finished_at
    ) VALUES (
      'task_fail_1', 'cron', 'agent_sub_1', 'conv_1', 'branch_1', 'cron_1', 'sess_sub_1',
      'failed', 'nightly sync', 'failed badly', 'boom', '2026-04-07T12:15:00.000Z', '2026-04-07T12:16:00.000Z'
    );

    INSERT INTO messages (
      id, session_id, seq, role, message_type, visibility, payload_json, created_at
    ) VALUES (
      'msg_tool_fail_1', 'sess_sub_1', 10, 'tool', 'tool_result', 'hidden',
      '{"toolName":"bash","isError":true,"content":[{"type":"text","text":"Permission request denied."}],"details":{"code":"permission_denied","request":{"scopes":[{"kind":"bash.full_access"}],"prefix":["lark-cli"]}}}',
      '2026-04-07T12:21:00.000Z'
    );

    INSERT INTO messages (
      id, session_id, seq, role, message_type, visibility, payload_json, created_at
    ) VALUES (
      'msg_tool_fail_2', 'sess_sub_1', 11, 'tool', 'tool_result', 'hidden',
      '{"toolName":"bash","isError":true,"content":[{"type":"text","text":"Permission request denied."}],"details":{"code":"permission_denied","request":{"scopes":[{"kind":"bash.full_access"}],"prefix":["lark-cli"]}}}',
      '2026-04-07T12:21:30.000Z'
    );
  `);
}

describe("MeditationPipelineRunner", () => {
  let handle: TestDatabaseHandle | null = null;
  let tempDir: string | null = null;

  afterEach(async () => {
    if (handle != null) {
      await destroyTestDatabase(handle);
      handle = null;
    }
    if (tempDir != null) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  test("runs bucket + consolidation, writes artifacts, and rewrites durable memory", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture(handle);
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokeclaw-meditation-runner-"));
    const workspaceDir = path.join(tempDir, "workspace");
    let bridgeCall = 0;

    const state = new MeditationStateRepo(handle.storage.db);
    state.markFinished({
      status: "completed",
      finishedAt: new Date("2026-03-20T00:00:00.000Z"),
      markSuccess: true,
    });

    const runner = new MeditationPipelineRunner({
      storage: handle.storage.db,
      state,
      config: {
        meditation: {
          enabled: true,
          cron: "0 0 * * *",
        },
      },
      models: createRegistry(),
      bridge: {
        async completeTurn() {
          bridgeCall += 1;
          if (bridgeCall === 1) {
            return createSubmitTurnResult({
              note: "The user clearly wanted diagnosis before explanation.",
              memory_candidates: [
                "For atlas-web frontend debugging, lead with diagnosis before explanation.",
              ],
            });
          }

          return createSubmitTurnResult({
            shared_memory_rewrite:
              "# Preferences\n\n- Prefer concise updates.\n\n# Working Conventions\n\n- Lead with diagnosis before explanation during debugging.\n",
            private_memory_rewrites: [
              {
                agent_id: "agent_sub_1",
                content:
                  "# Scope\n\n- atlas-web frontend.\n\n# Repeat-Use Lessons\n\n- Lead with diagnosis before explanation during atlas-web frontend debugging.\n",
              },
            ],
          });
        },
      },
      securityConfig: DEFAULT_CONFIG.security,
      workspaceDir,
      logsDir: tempDir,
      createRunId: () => "run_test",
      resolveCalendarContext: () => ({
        currentDate: "2026-04-08",
        timezone: "UTC",
      }),
    });

    await runner.runOnce({
      tickAt: new Date("2026-04-08T00:00:00.000Z"),
    });

    const artifactDir = path.join(tempDir, "meditation", "2026-04-08--run_test");
    const meta = JSON.parse(await readFile(path.join(artifactDir, "meta.json"), "utf8"));
    const harvest = JSON.parse(await readFile(path.join(artifactDir, "harvest.json"), "utf8"));
    const buckets = JSON.parse(await readFile(path.join(artifactDir, "buckets.json"), "utf8"));
    const bucketInputs = JSON.parse(
      await readFile(path.join(artifactDir, "bucket-inputs.json"), "utf8"),
    );
    const bucketPrompt = await readFile(
      path.join(artifactDir, "bucket-agent_sub_1.prompt.md"),
      "utf8",
    );
    const bucketSubmit = JSON.parse(
      await readFile(path.join(artifactDir, "bucket-agent_sub_1.submit.json"), "utf8"),
    );
    const bucketTurns = JSON.parse(
      await readFile(path.join(artifactDir, "bucket-agent_sub_1.turns.json"), "utf8"),
    );
    const consolidationPrompt = await readFile(
      path.join(artifactDir, "consolidation.prompt.md"),
      "utf8",
    );
    const consolidationSubmit = JSON.parse(
      await readFile(path.join(artifactDir, "consolidation.submit.json"), "utf8"),
    );
    const consolidationTurns = JSON.parse(
      await readFile(path.join(artifactDir, "consolidation.turns.json"), "utf8"),
    );
    const rewritePreviewShared = await readFile(
      path.join(artifactDir, "rewrite-preview", "shared.md"),
      "utf8",
    );
    const rewritePreviewPrivate = await readFile(
      path.join(artifactDir, "rewrite-preview", "private-agent_sub_1.md"),
      "utf8",
    );
    const dailyNote = await readFile(
      path.join(workspaceDir, "meditation", "2026-04-08.md"),
      "utf8",
    );
    const sharedMemory = await readFile(path.join(workspaceDir, "MEMORY.md"), "utf8");
    const privateMemory = await readFile(
      path.join(workspaceDir, "subagents", "agentsub", "MEMORY.md"),
      "utf8",
    );

    expect(meta).toMatchObject({
      runId: "run_test",
      localDate: "2026-04-08",
      timezone: "UTC",
      window: {
        startAt: "2026-04-01T00:00:00.000Z",
        endAt: "2026-04-08T00:00:00.000Z",
        clippedByLookback: true,
      },
      models: {
        bucketModelId: "anthropic_main/claude-sonnet-4-5",
        consolidationModelId: "openai_main/gpt-5-mini",
      },
      counts: {
        stops: 1,
        taskFailures: 1,
        failedToolResults: 2,
        buckets: 1,
        executedBuckets: 1,
      },
    });
    expect(harvest.stops).toHaveLength(1);
    expect(harvest.stops[0].runId).toBe("run_recent");
    expect(buckets).toMatchObject([
      {
        bucketId: "agent_sub_1",
        agentId: "agent_sub_1",
        profile: {
          displayName: "Atlas Frontend",
          description: "Handles atlas-web frontend tasks.",
          workdir: "/repo/atlas-web",
          compactSummary: "Recent atlas summary",
        },
      },
    ]);
    expect(bucketInputs).toMatchObject([
      {
        bucketId: "agent_sub_1",
        profile: {
          displayName: "Atlas Frontend",
        },
      },
    ]);
    expect(bucketPrompt).toContain("Atlas Frontend");
    expect(bucketPrompt).toContain("reduce future user friction");
    expect(bucketSubmit).toEqual({
      note: "The user clearly wanted diagnosis before explanation.",
      memory_candidates: [
        "For atlas-web frontend debugging, lead with diagnosis before explanation.",
      ],
    });
    expect(bucketTurns[0]?.content[0]).toMatchObject({
      type: "thinking",
      thinking: "Internal reasoning should stay in debug artifacts only.",
    });
    expect(consolidationPrompt).toContain("# Preferences");
    expect(consolidationSubmit).toEqual({
      shared_memory_rewrite:
        "# Preferences\n\n- Prefer concise updates.\n\n# Working Conventions\n\n- Lead with diagnosis before explanation during debugging.\n",
      private_memory_rewrites: [
        {
          agent_id: "agent_sub_1",
          content:
            "# Scope\n\n- atlas-web frontend.\n\n# Repeat-Use Lessons\n\n- Lead with diagnosis before explanation during atlas-web frontend debugging.\n",
        },
      ],
    });
    expect(consolidationTurns[0]?.content[0]).toMatchObject({
      type: "thinking",
      thinking: "Internal reasoning should stay in debug artifacts only.",
    });
    expect(rewritePreviewShared).toContain(
      "Lead with diagnosis before explanation during debugging.",
    );
    expect(rewritePreviewPrivate).toContain(
      "Lead with diagnosis before explanation during atlas-web frontend debugging.",
    );
    expect(dailyNote).toContain("## Run run_test");
    expect(dailyNote).toContain("The user clearly wanted diagnosis before explanation.");
    expect(dailyNote).not.toContain("Internal reasoning should stay in debug artifacts only.");
    expect(sharedMemory).toBe(
      "# Preferences\n\n- Prefer concise updates.\n\n# Working Conventions\n\n- Lead with diagnosis before explanation during debugging.\n",
    );
    expect(privateMemory).toBe(
      "# Scope\n\n- atlas-web frontend.\n\n# Repeat-Use Lessons\n\n- Lead with diagnosis before explanation during atlas-web frontend debugging.\n",
    );
  });

  test("drops private rewrites for non-sub agents at the host layer", () => {
    const filtered = filterEligiblePrivateMemoryRewrites({
      agentContexts: [
        {
          agentId: "agent_main_1",
          agentKind: "main",
          displayName: "Main",
          description: null,
          workdir: null,
          compactSummary: null,
          privateMemoryCurrent: null,
          bucketNote: "main note",
          memoryCandidates: ["shared lesson"],
        },
        {
          agentId: "agent_sub_1",
          agentKind: "sub",
          displayName: "Sub",
          description: null,
          workdir: null,
          compactSummary: null,
          privateMemoryCurrent: "# Scope\n",
          bucketNote: "sub note",
          memoryCandidates: ["private lesson"],
        },
      ],
      privateMemoryRewrites: [
        {
          agent_id: "agent_main_1",
          content: "# Scope\n- should be dropped\n",
        },
        {
          agent_id: "agent_sub_1",
          content: "# Scope\n- should stay\n",
        },
      ],
    });

    expect(filtered).toEqual([
      {
        agent_id: "agent_sub_1",
        content: "# Scope\n- should stay\n",
      },
    ]);
  });
});

function createSubmitTurnResult(args: Record<string, unknown>): PiBridgeRunTurnResult {
  return {
    provider: "openai_main",
    model: "gpt-5-mini",
    modelApi: "openai-responses",
    stopReason: "toolUse",
    content: [
      {
        type: "thinking",
        thinking: "Internal reasoning should stay in debug artifacts only.",
      },
      {
        type: "toolCall",
        id: "tool_1",
        name: "submit",
        arguments: args,
      },
    ],
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
  };
}
