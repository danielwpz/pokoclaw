import { describe, expect, test } from "vitest";
import { projectThinkTankEvent } from "@/src/orchestration/outbound-events.js";
import { ThinkTankConsultationsRepo } from "@/src/storage/repos/think-tank-consultations.repo.js";
import { ThinkTankEpisodesRepo } from "@/src/storage/repos/think-tank-episodes.repo.js";
import { ThinkTankParticipantsRepo } from "@/src/storage/repos/think-tank-participants.repo.js";
import {
  createTestDatabase,
  destroyTestDatabase,
  type TestDatabaseHandle,
} from "@/tests/storage/helpers/test-db.js";

function seedThinkTankFixture(handle: TestDatabaseHandle): void {
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
    ) VALUES
      ('sess_source', 'conv_1', 'branch_1', 'agent_1', 'chat', 'active', '2026-04-21T00:00:00.000Z', '2026-04-21T00:00:00.000Z'),
      ('sess_moderator', 'conv_1', 'branch_1', 'agent_1', 'think_tank', 'active', '2026-04-21T00:00:00.000Z', '2026-04-21T00:00:00.000Z'),
      ('sess_p1', 'conv_1', 'branch_1', 'agent_1', 'think_tank', 'active', '2026-04-21T00:00:00.000Z', '2026-04-21T00:00:00.000Z'),
      ('sess_p2', 'conv_1', 'branch_1', 'agent_1', 'think_tank', 'active', '2026-04-21T00:00:00.000Z', '2026-04-21T00:00:00.000Z');
  `);
}

describe("think tank repos", () => {
  test("persist consultation, participants, and episode state with structured summaries", async () => {
    const handle = await createTestDatabase(import.meta.url);

    try {
      seedThinkTankFixture(handle);

      const consultations = new ThinkTankConsultationsRepo(handle.storage.db);
      const participants = new ThinkTankParticipantsRepo(handle.storage.db);
      const episodes = new ThinkTankEpisodesRepo(handle.storage.db);

      consultations.create({
        id: "tt_1",
        sourceSessionId: "sess_source",
        sourceConversationId: "conv_1",
        sourceBranchId: "branch_1",
        ownerAgentId: "agent_1",
        moderatorSessionId: "sess_moderator",
        moderatorModelId: "codex-gpt5.4",
        status: "running",
        topic: "How should we design think tank events?",
        contextText: "Context packet.",
      });

      participants.create({
        id: "ttp_1",
        consultationId: "tt_1",
        participantId: "product_lead",
        title: "Product Lead",
        modelId: "openrouter-claude-sonnet-4",
        personaText: "Prioritize clarity, adoption, and user trust.",
        continuationSessionId: "sess_p1",
        sortOrder: 10,
      });
      participants.create({
        id: "ttp_2",
        consultationId: "tt_1",
        participantId: "infra_engineer",
        title: "Infra Engineer",
        modelId: "openrouter-gemini-3.1-flash",
        personaText: "Prioritize reliability and operational simplicity.",
        continuationSessionId: "sess_p2",
        sortOrder: 20,
      });

      episodes.create({
        id: "tte_1",
        consultationId: "tt_1",
        sequence: 1,
        status: "running",
        promptText: "Initial roundtable prompt.",
      });

      const runningEpisode = episodes.findActiveByConsultation("tt_1");
      expect(runningEpisode?.id).toBe("tte_1");

      episodes.update({
        id: "tte_1",
        status: "completed",
        result: {
          steps: [
            {
              key: "round_1",
              kind: "participant_round",
              title: "Round 1",
              order: 10,
              status: "completed",
              participantRound: {
                roundIndex: 1,
                entries: [
                  {
                    participantId: "product_lead",
                    title: "Product Lead",
                    model: "openrouter-claude-sonnet-4",
                    preview: "Prefer explicit structure.",
                    content: "Prefer explicit structure and demo-aligned cards.",
                  },
                ],
              },
            },
          ],
          latestSummary: {
            agreements: ["Need a channel-neutral event layer."],
            keyDifferences: ["How much stage planning belongs in runtime."],
            currentConclusion: "Stage snapshots should be explicit runtime artifacts.",
            openQuestions: ["How much step planning should be emitted at start?"],
          },
        },
        finishedAt: new Date("2026-04-21T01:00:00.000Z"),
      });

      consultations.update({
        id: "tt_1",
        status: "idle",
        latestSummary: {
          agreements: ["Need a channel-neutral event layer."],
          keyDifferences: ["How much stage planning belongs in runtime."],
          currentConclusion: "Stage snapshots should be explicit runtime artifacts.",
          openQuestions: ["How much step planning should be emitted at start?"],
        },
        firstCompletedAt: new Date("2026-04-21T01:00:00.000Z"),
        lastEpisodeStartedAt: new Date("2026-04-21T00:30:00.000Z"),
        lastEpisodeFinishedAt: new Date("2026-04-21T01:00:00.000Z"),
      });

      const consultation = consultations.getById("tt_1");
      expect(consultation?.status).toBe("idle");
      expect(consultation?.latestSummaryJson).not.toBeNull();

      const storedParticipants = participants.listByConsultation("tt_1");
      expect(storedParticipants.map((row) => row.participantId)).toEqual([
        "product_lead",
        "infra_engineer",
      ]);
      expect(
        participants.getByParticipantId({
          consultationId: "tt_1",
          participantId: "infra_engineer",
        })?.continuationSessionId,
      ).toBe("sess_p2");

      const settledEpisode = episodes.getById("tte_1");
      expect(settledEpisode?.status).toBe("completed");
      expect(settledEpisode?.resultJson).toContain("channel-neutral event layer");
    } finally {
      await destroyTestDatabase(handle);
    }
  });
});

describe("projectThinkTankEvent", () => {
  test("anchors think tank events to the source chat context", async () => {
    const handle = await createTestDatabase(import.meta.url);

    try {
      seedThinkTankFixture(handle);

      const envelope = projectThinkTankEvent({
        db: handle.storage.db,
        consultation: {
          id: "tt_1",
          sourceConversationId: "conv_1",
          sourceBranchId: "branch_1",
          sourceSessionId: "sess_source",
        },
        event: {
          type: "episode_step_upserted",
          episodeId: "tte_1",
          episodeSequence: 1,
          step: {
            key: "midpoint",
            kind: "moderator_summary",
            title: "Moderator Synthesis",
            order: 20,
            status: "completed",
            moderatorSummary: {
              summaryKind: "midpoint",
              summary: {
                agreements: ["Need explicit semantic steps."],
                keyDifferences: ["How much planning to emit upfront."],
                currentConclusion: "Emit snapshots, not deltas.",
                openQuestions: ["Should started events include planned steps?"],
              },
            },
          },
        },
      });

      expect(envelope.kind).toBe("think_tank_event");
      expect(envelope.target).toEqual({
        conversationId: "conv_1",
        branchId: "branch_1",
      });
      expect(envelope.session).toEqual({
        sessionId: "sess_source",
        purpose: "chat",
      });
      expect(envelope.consultationId).toBe("tt_1");
      expect(envelope.episodeId).toBe("tte_1");
      expect(envelope.event.type).toBe("episode_step_upserted");
    } finally {
      await destroyTestDatabase(handle);
    }
  });
});
