import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import type { PiBridgeRunTurnResult } from "@/src/agent/llm/pi-bridge.js";
import { ProviderRegistry } from "@/src/agent/llm/provider-registry.js";
import { DEFAULT_CONFIG } from "@/src/config/defaults.js";
import type { AppConfig } from "@/src/config/schema.js";
import { buildMeditationFindingId } from "@/src/meditation/prompts.js";
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

function createRegistry(options?: {
  meditationBucket?: string[];
  meditationConsolidation?: string[];
}): ProviderRegistry {
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
        task: ["anthropic_main/claude-sonnet-4-5", "openai_main/gpt-5-mini"],
        meditationBucket: options?.meditationBucket ?? ["anthropic_main/claude-sonnet-4-5"],
        meditationConsolidation: options?.meditationConsolidation ?? ["openai_main/gpt-5-mini"],
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
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokoclaw-meditation-runner-"));
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
              findings: [
                {
                  summary:
                    "For atlas-web frontend debugging, lead with diagnosis before explanation.",
                  issue_type: "user_preference_signal",
                  scope_hint: "subagent",
                  cluster_ids: ["stop:1"],
                  evidence_summary: "The user explicitly redirected the response style.",
                  examples: ["user quote: lead with the diagnosis first"],
                },
              ],
            });
          }

          if (bridgeCall === 2) {
            return createSubmitTurnResult({
              evaluations: [
                {
                  finding_id: buildMeditationFindingId("agent_sub_1", 0),
                  priority: "high",
                  durability: "durable",
                  promotion_decision: "private_memory",
                  reason: "This keeps repeating in atlas-web frontend work.",
                },
              ],
            });
          }

          return createSubmitTurnResult({
            shared_repeat_use_lessons: null,
            private_repeat_use_lessons: [
              {
                agent_id: "agent_sub_1",
                lessons: [
                  {
                    rule_text:
                      "Lead with diagnosis before explanation during atlas-web frontend debugging.",
                    supported_finding_ids: [buildMeditationFindingId("agent_sub_1", 0)],
                    why_generalizable:
                      "This is a stable future-facing collaboration rule for this subagent.",
                    evidence_examples: ["user quote: lead with the diagnosis first"],
                  },
                ],
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
    const consolidationEvalPrompt = await readFile(
      path.join(artifactDir, "consolidation-eval.prompt.md"),
      "utf8",
    );
    const consolidationEvalSubmit = JSON.parse(
      await readFile(path.join(artifactDir, "consolidation-eval.submit.json"), "utf8"),
    );
    const consolidationRewritePrompt = await readFile(
      path.join(artifactDir, "consolidation-rewrite.prompt.md"),
      "utf8",
    );
    const consolidationRewriteSubmit = JSON.parse(
      await readFile(path.join(artifactDir, "consolidation-rewrite.submit.json"), "utf8"),
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
      findings: [
        {
          summary: "For atlas-web frontend debugging, lead with diagnosis before explanation.",
          issue_type: "user_preference_signal",
          scope_hint: "subagent",
          cluster_ids: ["stop:1"],
          evidence_summary: "The user explicitly redirected the response style.",
          examples: ["user quote: lead with the diagnosis first"],
        },
      ],
    });
    expect(bucketTurns[0]?.content[0]).toMatchObject({
      type: "thinking",
      thinking: "Internal reasoning should stay in debug artifacts only.",
    });
    expect(consolidationEvalPrompt).toContain("# Preferences");
    expect(consolidationEvalSubmit).toEqual({
      evaluations: [
        {
          finding_id: buildMeditationFindingId("agent_sub_1", 0),
          priority: "high",
          durability: "durable",
          promotion_decision: "private_memory",
          reason: "This keeps repeating in atlas-web frontend work.",
        },
      ],
    });
    expect(consolidationRewritePrompt).toContain("Approved Shared Findings");
    expect(consolidationRewritePrompt).toContain("Approved Private Findings By Bucket");
    expect(consolidationRewriteSubmit).toEqual({
      shared_repeat_use_lessons: null,
      private_repeat_use_lessons: [
        {
          agent_id: "agent_sub_1",
          lessons: [
            {
              rule_text:
                "Lead with diagnosis before explanation during atlas-web frontend debugging.",
              supported_finding_ids: [buildMeditationFindingId("agent_sub_1", 0)],
              why_generalizable:
                "This is a stable future-facing collaboration rule for this subagent.",
              evidence_examples: ["user quote: lead with the diagnosis first"],
            },
          ],
        },
      ],
    });
    await expect(
      readFile(path.join(artifactDir, "rewrite-preview", "shared.md"), "utf8"),
    ).rejects.toThrow();
    expect(rewritePreviewPrivate).toContain(
      "Lead with diagnosis before explanation during atlas-web frontend debugging.",
    );
    expect(dailyNote).toContain("## Run run_test");
    expect(dailyNote).toContain("The user clearly wanted diagnosis before explanation.");
    expect(dailyNote).not.toContain("Internal reasoning should stay in debug artifacts only.");
    expect(sharedMemory).not.toContain("Lead with diagnosis before explanation during debugging.");
    expect(privateMemory).toBe(
      "# Scope\n\n# Durable Local Facts\n\n# Repeat-Use Lessons\n\n- Lead with diagnosis before explanation during atlas-web frontend debugging.\n",
    );
  });

  test("re-resolves meditation models from a provider registry source on each run", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture(handle);
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokoclaw-meditation-live-models-"));
    const workspaceDir = path.join(tempDir, "workspace");
    const state = new MeditationStateRepo(handle.storage.db);
    state.markFinished({
      status: "completed",
      finishedAt: new Date("2026-03-20T00:00:00.000Z"),
      markSuccess: true,
    });

    let currentRegistry = createRegistry();
    const registrySource = {
      current: () => currentRegistry,
    };
    const seenModels: string[] = [];
    let bridgeCall = 0;
    let runIdCounter = 0;
    const runner = new MeditationPipelineRunner({
      storage: handle.storage.db,
      state,
      config: {
        meditation: {
          enabled: true,
          cron: "0 0 * * *",
        },
      },
      models: registrySource as never,
      bridge: {
        async completeTurn(input) {
          bridgeCall += 1;
          seenModels.push(input.model.id);
          if (bridgeCall % 2 === 1) {
            return createSubmitTurnResult({
              note: `bucket note ${bridgeCall}`,
              findings: [],
            });
          }

          return createSubmitTurnResult({
            evaluations: [],
          });
        },
      },
      securityConfig: DEFAULT_CONFIG.security,
      workspaceDir,
      logsDir: tempDir,
      createRunId: () => `run_${++runIdCounter}`,
      resolveCalendarContext: () => ({
        currentDate: "2026-04-08",
        timezone: "UTC",
      }),
    });

    await runner.runOnce({
      tickAt: new Date("2026-04-08T00:00:00.000Z"),
    });

    currentRegistry = createRegistry({
      meditationBucket: ["openai_main/gpt-5-mini"],
      meditationConsolidation: ["anthropic_main/claude-sonnet-4-5"],
    });

    await runner.runOnce({
      tickAt: new Date("2026-04-09T00:00:00.000Z"),
    });

    expect(seenModels).toEqual([
      "anthropic_main/claude-sonnet-4-5",
      "openai_main/gpt-5-mini",
      "openai_main/gpt-5-mini",
      "anthropic_main/claude-sonnet-4-5",
    ]);
  });

  test("skips safely when meditation models are not configured", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture(handle);
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokoclaw-meditation-no-models-"));
    const workspaceDir = path.join(tempDir, "workspace");

    const state = new MeditationStateRepo(handle.storage.db);
    state.markFinished({
      status: "completed",
      finishedAt: new Date("2026-03-20T00:00:00.000Z"),
      markSuccess: true,
    });

    const config: Pick<AppConfig, "providers" | "models"> = {
      providers: {
        anthropic_main: {
          api: "anthropic-messages",
          apiKey: "anthropic-secret",
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

    const runner = new MeditationPipelineRunner({
      storage: handle.storage.db,
      state,
      config: {
        meditation: {
          enabled: true,
          cron: "0 0 * * *",
        },
      },
      models: new ProviderRegistry(config),
      bridge: {
        async completeTurn() {
          throw new Error("bridge should not be called when meditation models are missing");
        },
      },
      securityConfig: DEFAULT_CONFIG.security,
      workspaceDir,
      logsDir: tempDir,
      createRunId: () => "run_no_models",
      resolveCalendarContext: () => ({
        currentDate: "2026-04-08",
        timezone: "UTC",
      }),
    });

    const result = await runner.runOnce({
      tickAt: new Date("2026-04-08T00:00:00.000Z"),
    });

    const artifactDir = path.join(tempDir, "meditation", "2026-04-08--run_no_models");
    const meta = JSON.parse(await readFile(path.join(artifactDir, "meta.json"), "utf8"));

    expect(result).toEqual({
      skipped: true,
      reason: "no_models",
      bucketsExecuted: 0,
    });
    expect(meta).toMatchObject({
      runId: "run_no_models",
      localDate: "2026-04-08",
      models: {
        bucketModelId: null,
        consolidationModelId: null,
      },
      counts: {
        buckets: 1,
        executedBuckets: 0,
      },
    });
    await expect(
      readFile(path.join(workspaceDir, "meditation", "2026-04-08.md"), "utf8"),
    ).rejects.toThrow();
  });

  test("persists early artifacts even when a bucket phase fails later", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture(handle);
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokoclaw-meditation-runner-fail-"));

    const runner = new MeditationPipelineRunner({
      storage: handle.storage.db,
      state: new MeditationStateRepo(handle.storage.db),
      config: {
        meditation: {
          enabled: true,
          cron: "0 0 * * *",
        },
      },
      models: createRegistry(),
      bridge: {
        async completeTurn() {
          throw new Error("bucket llm failed");
        },
      },
      securityConfig: DEFAULT_CONFIG.security,
      workspaceDir: path.join(tempDir, "workspace"),
      logsDir: tempDir,
      createRunId: () => "run_fail",
      resolveCalendarContext: () => ({
        currentDate: "2026-04-08",
        timezone: "UTC",
      }),
    });

    await expect(
      runner.runOnce({
        tickAt: new Date("2026-04-08T00:00:00.000Z"),
      }),
    ).rejects.toThrow("bucket llm failed");

    const artifactDir = path.join(tempDir, "meditation", "2026-04-08--run_fail");
    const meta = JSON.parse(await readFile(path.join(artifactDir, "meta.json"), "utf8"));
    const harvest = JSON.parse(await readFile(path.join(artifactDir, "harvest.json"), "utf8"));
    const clusters = JSON.parse(await readFile(path.join(artifactDir, "clusters.json"), "utf8"));

    expect(meta.runId).toBe("run_fail");
    expect(harvest.stops).toHaveLength(1);
    expect(clusters).toHaveLength(1);
  });

  test("uses a provided window override instead of state-derived meditation window", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture(handle);
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokoclaw-meditation-window-override-"));

    const state = new MeditationStateRepo(handle.storage.db);
    state.markFinished({
      status: "completed",
      finishedAt: new Date("2026-04-07T23:59:00.000Z"),
      markSuccess: true,
    });

    let bridgeCall = 0;
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
              note: "A permission burst happened.",
              findings: [
                {
                  summary: "Pause after burst permission failures.",
                  issue_type: "agent_workflow_issue",
                  scope_hint: "subagent",
                  cluster_ids: ["tool_burst:1"],
                  evidence_summary: "A burst of permission failures happened in one run.",
                  examples: ["tool error: Permission request denied."],
                },
              ],
            });
          }

          return createSubmitTurnResult({
            evaluations: [
              {
                finding_id: buildMeditationFindingId("agent_sub_1", 0),
                priority: "low",
                durability: "transient",
                promotion_decision: "keep_in_meditation",
                reason: "Not durable.",
              },
            ],
          });
        },
      },
      securityConfig: DEFAULT_CONFIG.security,
      workspaceDir: path.join(tempDir, "workspace"),
      logsDir: tempDir,
      createRunId: () => "run_override",
    });

    await runner.runOnce({
      tickAt: new Date("2026-04-08T00:00:00.000Z"),
      windowOverride: {
        startAt: "2026-04-01T00:00:00.000Z",
        endAt: "2026-04-02T00:00:00.000Z",
        lastSuccessAt: null,
        localDate: "2026-04-08",
        timezone: "UTC",
        clippedByLookback: false,
      },
    });

    const artifactDir = path.join(tempDir, "meditation", "2026-04-08--run_override");
    const meta = JSON.parse(await readFile(path.join(artifactDir, "meta.json"), "utf8"));
    expect(meta.window).toMatchObject({
      startAt: "2026-04-01T00:00:00.000Z",
      endAt: "2026-04-02T00:00:00.000Z",
      clippedByLookback: false,
    });
  });

  test("drops shared rewrites that were not approved by evaluation", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture(handle);
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokoclaw-meditation-empty-shared-"));
    const workspaceDir = path.join(tempDir, "workspace");
    let bridgeCall = 0;

    const state = new MeditationStateRepo(handle.storage.db);
    state.markFinished({
      status: "completed",
      finishedAt: new Date("2026-03-20T00:00:00.000Z"),
      markSuccess: true,
    });

    const initialSharedMemory = "# Existing Shared Memory\n\n- Keep this content.\n";
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(path.join(workspaceDir, "MEMORY.md"), initialSharedMemory, "utf8");
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
              note: "A permission burst happened.",
              findings: [
                {
                  summary: "Pause after burst permission failures.",
                  issue_type: "agent_workflow_issue",
                  scope_hint: "subagent",
                  cluster_ids: ["tool_burst:1"],
                  evidence_summary: "A burst of permission failures happened in one run.",
                  examples: ["tool error: Permission request denied."],
                },
              ],
            });
          }

          if (bridgeCall === 2) {
            return createSubmitTurnResult({
              evaluations: [
                {
                  finding_id: buildMeditationFindingId("agent_sub_1", 0),
                  priority: "high",
                  durability: "durable",
                  promotion_decision: "private_memory",
                  reason: "This should update only private memory.",
                },
              ],
            });
          }

          return createSubmitTurnResult({
            shared_repeat_use_lessons: [
              {
                rule_text: "This should be dropped.",
                supported_finding_ids: [],
                why_generalizable: "",
                evidence_examples: [],
              },
            ],
            private_repeat_use_lessons: [
              {
                agent_id: "agent_sub_1",
                lessons: [
                  {
                    rule_text: "Keep the private rewrite.",
                    supported_finding_ids: [buildMeditationFindingId("agent_sub_1", 0)],
                    why_generalizable: "This is still a future-facing subagent rule.",
                    evidence_examples: ["tool error: Permission request denied."],
                  },
                ],
              },
            ],
          });
        },
      },
      securityConfig: DEFAULT_CONFIG.security,
      workspaceDir,
      logsDir: tempDir,
      createRunId: () => "run_empty_shared",
      resolveCalendarContext: () => ({
        currentDate: "2026-04-08",
        timezone: "UTC",
      }),
    });

    await runner.runOnce({
      tickAt: new Date("2026-04-08T00:00:00.000Z"),
    });

    const artifactDir = path.join(tempDir, "meditation", "2026-04-08--run_empty_shared");
    const dailyNote = await readFile(
      path.join(workspaceDir, "meditation", "2026-04-08.md"),
      "utf8",
    );
    const sharedMemory = await readFile(path.join(workspaceDir, "MEMORY.md"), "utf8");
    const consolidationRewriteSubmit = JSON.parse(
      await readFile(path.join(artifactDir, "consolidation-rewrite.submit.json"), "utf8"),
    );
    const rewriteRejections = JSON.parse(
      await readFile(path.join(artifactDir, "rewrite-rejections.json"), "utf8"),
    );

    expect(consolidationRewriteSubmit).toMatchObject({
      shared_repeat_use_lessons: [
        {
          rule_text: "This should be dropped.",
        },
      ],
    });
    expect(dailyNote).toContain("Shared memory rewritten: no");
    expect(dailyNote).toContain("Rewrite rejections:");
    expect(sharedMemory).toBe(initialSharedMemory);
    expect(rewriteRejections).toEqual([
      {
        target: "shared",
        reasons: expect.arrayContaining([
          "missing_supported_finding_ids",
          "missing_generalization_reason",
          "missing_evidence_examples",
        ]),
      },
    ]);
    await expect(
      readFile(path.join(artifactDir, "rewrite-preview", "shared.md"), "utf8"),
    ).rejects.toThrow();
  });

  test("drops private rewrites for non-sub agents at the host layer", () => {
    const filtered = filterEligiblePrivateMemoryRewrites({
      bucketPackets: [
        {
          agentId: "agent_main_1",
          agentKind: "main",
          approvedPrivateFindings: [],
        },
        {
          agentId: "agent_sub_1",
          agentKind: "sub",
          approvedPrivateFindings: [
            {
              findingId: buildMeditationFindingId("bucket_sub_1", 0),
              agentId: "agent_sub_1",
              agentKind: "sub",
              priority: "high",
              durability: "durable",
              promotionDecision: "private_memory",
              reason: "ok",
              summary: "summary",
              issueType: "agent_workflow_issue",
              scopeHint: "subagent",
              evidenceSummary: "evidence",
              examples: ["tool error: Permission request denied."],
            },
          ],
        },
      ],
      privateMemoryRewrites: [
        {
          agent_id: "agent_main_1",
          lessons: [
            {
              rule_text: "should be dropped",
              supported_finding_ids: [buildMeditationFindingId("bucket_sub_1", 0)],
              why_generalizable: "nope",
              evidence_examples: ["example"],
            },
          ],
        },
        {
          agent_id: "agent_sub_1",
          lessons: [
            {
              rule_text: "should stay",
              supported_finding_ids: [buildMeditationFindingId("bucket_sub_1", 0)],
              why_generalizable: "ok",
              evidence_examples: ["example"],
            },
          ],
        },
      ],
    });

    expect(filtered).toEqual([
      {
        agentId: "agent_sub_1",
        lessons: [
          {
            rule_text: "should stay",
            supported_finding_ids: [buildMeditationFindingId("bucket_sub_1", 0)],
            why_generalizable: "ok",
            evidence_examples: ["example"],
          },
        ],
      },
    ]);
  });

  test("drops private rewrites for sub agents without private-approved findings", () => {
    const filtered = filterEligiblePrivateMemoryRewrites({
      bucketPackets: [
        {
          agentId: "agent_sub_1",
          agentKind: "sub",
          approvedPrivateFindings: [],
        },
      ],
      privateMemoryRewrites: [
        {
          agent_id: "agent_sub_1",
          lessons: [
            {
              rule_text: "should be dropped",
              supported_finding_ids: [buildMeditationFindingId("bucket_sub_1", 0)],
              why_generalizable: "nope",
              evidence_examples: ["example"],
            },
          ],
        },
      ],
    });

    expect(filtered).toEqual([]);
  });

  test("drops structurally invalid private rewrites at the host layer", () => {
    const filtered = filterEligiblePrivateMemoryRewrites({
      bucketPackets: [
        {
          agentId: "agent_sub_1",
          agentKind: "sub",
          approvedPrivateFindings: [
            {
              findingId: buildMeditationFindingId("bucket_sub_1", 0),
              agentId: "agent_sub_1",
              agentKind: "sub",
              priority: "high",
              durability: "durable",
              promotionDecision: "private_memory",
              reason: "ok",
              summary: "summary",
              issueType: "agent_workflow_issue",
              scopeHint: "subagent",
              evidenceSummary: "evidence",
              examples: ["tool error: Permission request denied."],
            },
          ],
        },
      ],
      privateMemoryRewrites: [
        {
          agent_id: "agent_sub_1",
          lessons: [
            {
              rule_text: "",
              supported_finding_ids: [],
              why_generalizable: "",
              evidence_examples: [],
            },
          ],
        },
      ],
    });

    expect(filtered).toEqual([]);
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
