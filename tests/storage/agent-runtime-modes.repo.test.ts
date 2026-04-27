import { afterEach, describe, expect, test } from "vitest";

import { AgentRuntimeModesRepo } from "@/src/storage/repos/agent-runtime-modes.repo.js";
import {
  createTestDatabase,
  destroyTestDatabase,
  type TestDatabaseHandle,
} from "@/tests/storage/helpers/test-db.js";

function seedAgentFixture(handle: TestDatabaseHandle): void {
  handle.storage.sqlite.exec(`
    INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
    VALUES ('ci_1', 'lark', 'acct_a', '2026-03-22T00:00:00.000Z', '2026-03-22T00:00:00.000Z');
    INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
    VALUES ('conv_1', 'ci_1', 'chat_1', 'dm', '2026-03-22T00:00:00.000Z', '2026-03-22T00:00:00.000Z');
    INSERT INTO agents (id, conversation_id, kind, created_at)
    VALUES ('agent_1', 'conv_1', 'main', '2026-03-22T00:00:00.000Z');
  `);
}

describe("agent runtime modes repo", () => {
  let handle: TestDatabaseHandle | null = null;

  afterEach(async () => {
    if (handle != null) {
      await destroyTestDatabase(handle);
      handle = null;
    }
  });

  test("missing rows default to yolo disabled without creating state", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedAgentFixture(handle);
    const repo = new AgentRuntimeModesRepo(handle.storage.db);

    expect(repo.getByOwnerAgentId("agent_1")).toBeNull();
    expect(repo.isYoloEnabled("agent_1")).toBe(false);
    expect(repo.getByOwnerAgentId("agent_1")).toBeNull();
  });

  test("toggleYolo creates and flips persisted yolo state", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedAgentFixture(handle);
    const repo = new AgentRuntimeModesRepo(handle.storage.db);

    const enabled = repo.toggleYolo({
      ownerAgentId: "agent_1",
      updatedAt: new Date("2026-03-22T00:00:01.000Z"),
      updatedBy: "lark:default:ou_sender",
    });

    expect(enabled).toMatchObject({
      ownerAgentId: "agent_1",
      yoloEnabled: true,
      yoloEnabledAt: "2026-03-22T00:00:01.000Z",
      yoloUpdatedAt: "2026-03-22T00:00:01.000Z",
      yoloUpdatedBy: "lark:default:ou_sender",
    });

    const disabled = repo.toggleYolo({
      ownerAgentId: "agent_1",
      updatedAt: new Date("2026-03-22T00:00:02.000Z"),
      updatedBy: "lark:default:ou_sender",
      disableSnoozedUntil: new Date("2026-03-23T00:00:02.000Z"),
    });

    expect(disabled).toMatchObject({
      ownerAgentId: "agent_1",
      yoloEnabled: false,
      yoloEnabledAt: null,
      yoloUpdatedAt: "2026-03-22T00:00:02.000Z",
      yoloUpdatedBy: "lark:default:ou_sender",
      yoloSnoozedUntil: "2026-03-23T00:00:02.000Z",
    });
  });

  test("updateYoloPromptState creates a row and stores debounce fields", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedAgentFixture(handle);
    const repo = new AgentRuntimeModesRepo(handle.storage.db);

    const row = repo.updateYoloPromptState({
      ownerAgentId: "agent_1",
      updatedAt: new Date("2026-03-22T00:00:00.000Z"),
      approvalStreakCount: 2,
      approvalStreakStartedAt: new Date("2026-03-22T00:00:01.000Z"),
      lastApprovalRequestedAt: new Date("2026-03-22T00:01:00.000Z"),
      lastYoloPromptedAt: new Date("2026-03-22T00:01:01.000Z"),
      yoloPromptCountToday: 1,
      yoloPromptCountDay: "2026-03-22",
    });

    expect(row).toMatchObject({
      ownerAgentId: "agent_1",
      yoloEnabled: false,
      approvalStreakCount: 2,
      approvalStreakStartedAt: "2026-03-22T00:00:01.000Z",
      lastApprovalRequestedAt: "2026-03-22T00:01:00.000Z",
      lastYoloPromptedAt: "2026-03-22T00:01:01.000Z",
      yoloPromptCountToday: 1,
      yoloPromptCountDay: "2026-03-22",
    });
  });

  test("runtime mode rows are removed when the owner agent is deleted", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedAgentFixture(handle);
    const repo = new AgentRuntimeModesRepo(handle.storage.db);
    repo.toggleYolo({
      ownerAgentId: "agent_1",
      updatedAt: new Date("2026-03-22T00:00:01.000Z"),
    });

    handle.storage.sqlite.exec("DELETE FROM agents WHERE id = 'agent_1'");

    expect(repo.getByOwnerAgentId("agent_1")).toBeNull();
  });
});
