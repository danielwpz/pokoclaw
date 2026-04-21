import { describe, expect, test } from "vitest";

import type { ModelScenario } from "@/src/agent/llm/models.js";
import { ProviderRegistry } from "@/src/agent/llm/provider-registry.js";
import { StaticProviderRegistrySource } from "@/src/agent/llm/provider-registry-source.js";
import { AgentManager } from "@/src/orchestration/agent-manager.js";
import type { OrchestratedOutboundEventEnvelope } from "@/src/orchestration/outbound-events.js";
import { RuntimeEventBus } from "@/src/runtime/event-bus.js";
import { ThinkTankConsultationsRepo } from "@/src/storage/repos/think-tank-consultations.repo.js";
import { ThinkTankEpisodesRepo } from "@/src/storage/repos/think-tank-episodes.repo.js";
import { ThinkTankParticipantsRepo } from "@/src/storage/repos/think-tank-participants.repo.js";
import {
  createTestDatabase,
  destroyTestDatabase,
  type TestDatabaseHandle,
} from "@/tests/storage/helpers/test-db.js";

function makeStartedRun(input: { sessionId: string; scenario: ModelScenario }) {
  return {
    status: "started" as const,
    messageId: "msg_started",
    run: {
      runId: "run_started",
      sessionId: input.sessionId,
      scenario: input.scenario,
      modelId: "test-model",
      appendedMessageIds: [],
      toolExecutions: 0,
      compaction: {
        shouldCompact: false,
        reason: null,
        thresholdTokens: 1000,
        effectiveWindow: 2000,
      },
      events: [],
      stopSignal: null,
    },
  };
}

function makeCompletedThinkTankRun(input: { sessionId: string; scenario: ModelScenario }) {
  return {
    status: "started" as const,
    messageId: "msg_started",
    run: {
      runId: "run_started",
      sessionId: input.sessionId,
      scenario: input.scenario,
      modelId: "test-model",
      appendedMessageIds: [],
      toolExecutions: 1,
      compaction: {
        shouldCompact: false,
        reason: null,
        thresholdTokens: 1000,
        effectiveWindow: 2000,
      },
      events: [],
      stopSignal: {
        reason: "think_tank_episode_completion",
        payload: {
          thinkTankEpisodeCompletion: {
            summary: {
              agreements: ["Use a thin semantic event layer."],
              keyDifferences: ["How much channel rendering should be standardized."],
              currentConclusion:
                "Runtime should publish stable events and let each channel render independently.",
              openQuestions: ["How much UI richness should non-Lark channels match?"],
            },
            steps: [
              {
                key: "final",
                kind: "final_summary",
                title: "Current Conclusion",
                order: 40,
                summaryKind: "final",
                summary: {
                  agreements: ["Use a thin semantic event layer."],
                  keyDifferences: ["How much channel rendering should be standardized."],
                  currentConclusion:
                    "Runtime should publish stable events and let each channel render independently.",
                  openQuestions: ["How much UI richness should non-Lark channels match?"],
                },
              },
            ],
          },
        },
      },
    },
  };
}

function seedFixture(handle: TestDatabaseHandle): void {
  handle.storage.sqlite.exec(`
    INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
    VALUES ('ci_1', 'lark', 'acct_a', '2026-04-21T00:00:00.000Z', '2026-04-21T00:00:00.000Z');

    INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
    VALUES ('conv_1', 'ci_1', 'chat_1', 'dm', '2026-04-21T00:00:00.000Z', '2026-04-21T00:00:00.000Z');

    INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
    VALUES ('branch_1', 'conv_1', 'dm_main', 'main', '2026-04-21T00:00:00.000Z', '2026-04-21T00:00:00.000Z');

    INSERT INTO agents (id, conversation_id, kind, created_at)
    VALUES ('agent_1', 'conv_1', 'main', '2026-04-21T00:00:00.000Z');

    INSERT INTO sessions (
      id, conversation_id, branch_id, owner_agent_id, purpose, status, created_at, updated_at
    ) VALUES (
      'sess_source', 'conv_1', 'branch_1', 'agent_1', 'chat', 'active',
      '2026-04-21T00:00:00.000Z', '2026-04-21T00:00:00.000Z'
    );
  `);
}

function createModelSource() {
  return new StaticProviderRegistrySource(
    new ProviderRegistry({
      providers: {
        openrouter: {
          api: "openai-responses",
        },
        codex: {
          api: "openai-codex-responses",
        },
      },
      models: {
        catalog: [
          {
            id: "openrouter-claude-sonnet-4",
            provider: "openrouter",
            upstreamId: "anthropic/claude-sonnet-4",
            contextWindow: 200_000,
            maxOutputTokens: 16_384,
            supportsTools: true,
            supportsVision: false,
          },
          {
            id: "openrouter-gemini-3.1-flash",
            provider: "openrouter",
            upstreamId: "google/gemini-3.1-flash",
            contextWindow: 200_000,
            maxOutputTokens: 16_384,
            supportsTools: true,
            supportsVision: false,
          },
          {
            id: "codex-gpt5.4",
            provider: "codex",
            upstreamId: "gpt-5.4",
            contextWindow: 200_000,
            maxOutputTokens: 16_384,
            supportsTools: true,
            supportsVision: false,
          },
        ],
        scenarios: {
          chat: ["codex-gpt5.4"],
          compaction: ["codex-gpt5.4"],
          task: ["codex-gpt5.4"],
          thinkTankAdvisor: ["openrouter-claude-sonnet-4", "openrouter-gemini-3.1-flash"],
          meditationBucket: [],
          meditationConsolidation: [],
        },
      },
    }),
  );
}

describe("AgentManager think tank runtime contracts", () => {
  test("creates consultation rows, participant sessions, and start events", async () => {
    const handle = await createTestDatabase(import.meta.url);
    let manager: AgentManager | null = null;

    try {
      seedFixture(handle);

      const bus = new RuntimeEventBus<OrchestratedOutboundEventEnvelope>();
      const events: OrchestratedOutboundEventEnvelope[] = [];
      const unsubscribe = bus.subscribe((event) => {
        events.push(event);
      });

      manager = new AgentManager({
        storage: handle.storage.db,
        ingress: {
          submitMessage: async (input) =>
            makeStartedRun({
              sessionId: input.sessionId,
              scenario: input.scenario,
            }),
          submitApprovalDecision: () => true,
        },
        outboundEventBus: bus,
        models: createModelSource(),
      });

      expect(manager.getThinkTankCapabilities({ sourceSessionId: "sess_source" })).toEqual({
        availableModels: ["openrouter-claude-sonnet-4", "openrouter-gemini-3.1-flash"],
        recommendedParticipantCount: 2,
        maxParticipantCount: 4,
      });

      const started = await manager.startThinkTankConsultation({
        sourceSessionId: "sess_source",
        sourceConversationId: "conv_1",
        sourceBranchId: "branch_1",
        ownerAgentId: "agent_1",
        moderatorModelId: "codex-gpt5.4",
        topic: "How should think tank runtime and channel stay decoupled?",
        context: "Need a stable event layer.",
        participants: [
          {
            id: "product_lead",
            model: "openrouter-claude-sonnet-4",
            persona: "Prioritize product clarity and user trust.",
            title: "Product Lead",
          },
          {
            id: "infra_engineer",
            model: "openrouter-gemini-3.1-flash",
            persona: "Prioritize reliability and operating simplicity.",
            title: "Infra Engineer",
          },
        ],
      });

      expect(started.accepted).toBe(true);
      expect(started.status).toBe("running");
      expect(started.participants).toHaveLength(2);

      const consultation = new ThinkTankConsultationsRepo(handle.storage.db).getById(
        started.consultationId,
      );
      expect(consultation?.status).toBe("running");
      expect(consultation?.moderatorModelId).toBe("codex-gpt5.4");

      const participants = new ThinkTankParticipantsRepo(handle.storage.db).listByConsultation(
        started.consultationId,
      );
      expect(participants).toHaveLength(2);
      expect(participants.map((participant) => participant.participantId)).toEqual([
        "product_lead",
        "infra_engineer",
      ]);

      const episodes = new ThinkTankEpisodesRepo(handle.storage.db).listByConsultation(
        started.consultationId,
      );
      expect(episodes).toHaveLength(1);
      expect(episodes[0]?.status).toBe("running");

      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        kind: "think_tank_event",
        consultationId: started.consultationId,
        event: {
          type: "consultation_upserted",
        },
      });
      expect(events[1]).toMatchObject({
        kind: "think_tank_event",
        consultationId: started.consultationId,
        event: {
          type: "episode_started",
        },
      });

      unsubscribe();
    } finally {
      if (manager != null) {
        await manager.waitForThinkTankIdle();
      }
      await destroyTestDatabase(handle);
    }
  });

  test("continues an idle consultation by creating the next episode and publishing follow-up events", async () => {
    const handle = await createTestDatabase(import.meta.url);
    let manager: AgentManager | null = null;

    try {
      seedFixture(handle);

      const bus = new RuntimeEventBus<OrchestratedOutboundEventEnvelope>();
      const events: OrchestratedOutboundEventEnvelope[] = [];
      const unsubscribe = bus.subscribe((event) => {
        events.push(event);
      });

      manager = new AgentManager({
        storage: handle.storage.db,
        ingress: {
          submitMessage: async (input) =>
            makeCompletedThinkTankRun({
              sessionId: input.sessionId,
              scenario: input.scenario,
            }),
          submitApprovalDecision: () => true,
        },
        outboundEventBus: bus,
        models: createModelSource(),
      });

      const started = await manager.startThinkTankConsultation({
        sourceSessionId: "sess_source",
        sourceConversationId: "conv_1",
        sourceBranchId: "branch_1",
        ownerAgentId: "agent_1",
        moderatorModelId: "codex-gpt5.4",
        topic: "How should think tank runtime and channel stay decoupled?",
        context: "Need a stable event layer.",
        participants: [
          {
            id: "product_lead",
            model: "openrouter-claude-sonnet-4",
            persona: "Prioritize product clarity and user trust.",
            title: "Product Lead",
          },
          {
            id: "infra_engineer",
            model: "openrouter-gemini-3.1-flash",
            persona: "Prioritize reliability and operating simplicity.",
            title: "Infra Engineer",
          },
        ],
      });
      await manager.waitForThinkTankIdle();
      events.length = 0;

      const continued = manager.continueThinkTankConsultation({
        consultationId: started.consultationId,
        prompt: "Follow up: how should thread replies map back into the same consultation?",
        createdAt: new Date("2026-04-21T00:10:00.000Z"),
      });

      expect(continued).toMatchObject({
        accepted: true,
        consultationId: started.consultationId,
        episodeSequence: 2,
        status: "running",
      });

      await manager.waitForThinkTankIdle();

      const episodes = new ThinkTankEpisodesRepo(handle.storage.db).listByConsultation(
        started.consultationId,
      );
      expect(episodes).toHaveLength(2);
      expect(episodes[1]).toMatchObject({
        sequence: 2,
        promptText: "Follow up: how should thread replies map back into the same consultation?",
        status: "completed",
      });

      expect(
        events.map((event) => (event.kind === "think_tank_event" ? event.event.type : null)),
      ).toEqual([
        "consultation_upserted",
        "episode_started",
        "episode_step_upserted",
        "episode_settled",
        "consultation_upserted",
      ]);
      expect(events[1]).toMatchObject({
        kind: "think_tank_event",
        consultationId: started.consultationId,
        event: {
          type: "episode_started",
          episodeSequence: 2,
        },
      });

      unsubscribe();
    } finally {
      if (manager != null) {
        await manager.waitForThinkTankIdle();
      }
      await destroyTestDatabase(handle);
    }
  });
});
