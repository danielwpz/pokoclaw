import { afterEach, describe, expect, test } from "vitest";

import {
  RuntimeModeService,
  YOLO_MANUAL_DISABLE_SNOOZE_MS,
  YOLO_SUGGESTION_DEBOUNCE_MS,
  YOLO_SUGGESTION_MESSAGE,
} from "@/src/runtime/runtime-modes.js";
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

describe("runtime mode service", () => {
  let handle: TestDatabaseHandle | null = null;

  afterEach(async () => {
    if (handle != null) {
      await destroyTestDatabase(handle);
      handle = null;
    }
  });

  test("suggests yolo after two user approvals within five minutes", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedAgentFixture(handle);
    const service = new RuntimeModeService({
      storage: handle.storage.db,
      autopilotEnabled: false,
    });

    expect(YOLO_SUGGESTION_MESSAGE).toBe(
      "💡 Too many approval stops? Send `/yolo` if you want this agent to keep going without asking each time.",
    );
    expect(
      service.recordApprovalRequestForYoloSuggestion({
        ownerAgentId: "agent_1",
        approvalTarget: "user",
        requestedAt: new Date("2026-03-22T00:00:00.000Z"),
      }),
    ).toBe(false);
    expect(
      service.recordApprovalRequestForYoloSuggestion({
        ownerAgentId: "agent_1",
        approvalTarget: "user",
        requestedAt: new Date("2026-03-22T00:04:59.000Z"),
      }),
    ).toBe(true);

    const row = new AgentRuntimeModesRepo(handle.storage.db).getByOwnerAgentId("agent_1");
    expect(row).toMatchObject({
      approvalStreakCount: 0,
      approvalStreakStartedAt: null,
      lastYoloPromptedAt: "2026-03-22T00:04:59.000Z",
      yoloSnoozedUntil: null,
    });
  });

  test("debounces automatic yolo suggestions for twelve hours", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedAgentFixture(handle);
    const service = new RuntimeModeService({
      storage: handle.storage.db,
      autopilotEnabled: false,
    });

    expect(
      service.recordApprovalRequestForYoloSuggestion({
        ownerAgentId: "agent_1",
        approvalTarget: "user",
        requestedAt: new Date("2026-03-22T00:00:00.000Z"),
      }),
    ).toBe(false);
    expect(
      service.recordApprovalRequestForYoloSuggestion({
        ownerAgentId: "agent_1",
        approvalTarget: "user",
        requestedAt: new Date("2026-03-22T00:01:00.000Z"),
      }),
    ).toBe(true);

    const beforeDebounceEnds = new Date(
      new Date("2026-03-22T00:01:00.000Z").getTime() + YOLO_SUGGESTION_DEBOUNCE_MS - 1,
    );
    expect(
      service.recordApprovalRequestForYoloSuggestion({
        ownerAgentId: "agent_1",
        approvalTarget: "user",
        requestedAt: beforeDebounceEnds,
      }),
    ).toBe(false);

    expect(
      service.recordApprovalRequestForYoloSuggestion({
        ownerAgentId: "agent_1",
        approvalTarget: "user",
        requestedAt: new Date("2026-03-22T12:01:00.000Z"),
      }),
    ).toBe(false);
    expect(
      service.recordApprovalRequestForYoloSuggestion({
        ownerAgentId: "agent_1",
        approvalTarget: "user",
        requestedAt: new Date("2026-03-22T12:02:00.000Z"),
      }),
    ).toBe(true);
  });

  test("does not suggest in autopilot or when yolo is enabled", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedAgentFixture(handle);
    const service = new RuntimeModeService({
      storage: handle.storage.db,
      autopilotEnabled: false,
    });

    expect(
      service.recordApprovalRequestForYoloSuggestion({
        ownerAgentId: "agent_1",
        approvalTarget: "user",
        requestedAt: new Date("2026-03-22T00:00:00.000Z"),
      }),
    ).toBe(false);
    expect(
      service.recordApprovalRequestForYoloSuggestion({
        ownerAgentId: "agent_1",
        approvalTarget: "user",
        requestedAt: new Date("2026-03-22T00:01:00.000Z"),
      }),
    ).toBe(true);
    expect(
      service.recordApprovalRequestForYoloSuggestion({
        ownerAgentId: "agent_1",
        approvalTarget: "user",
        requestedAt: new Date("2026-03-23T00:01:00.000Z"),
      }),
    ).toBe(false);

    const autopilotService = new RuntimeModeService({
      storage: handle.storage.db,
      autopilotEnabled: true,
    });
    expect(
      autopilotService.recordApprovalRequestForYoloSuggestion({
        ownerAgentId: "agent_1",
        approvalTarget: "user",
        requestedAt: new Date("2026-03-25T00:01:00.000Z"),
      }),
    ).toBe(false);

    service.toggleYolo({
      ownerAgentId: "agent_1",
      updatedAt: new Date("2026-03-26T00:00:00.000Z"),
    });
    expect(
      service.recordApprovalRequestForYoloSuggestion({
        ownerAgentId: "agent_1",
        approvalTarget: "user",
        requestedAt: new Date("2026-03-26T00:01:00.000Z"),
      }),
    ).toBe(false);
  });

  test("manual yolo disable snoozes automatic suggestions for three days", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedAgentFixture(handle);
    const service = new RuntimeModeService({
      storage: handle.storage.db,
      autopilotEnabled: false,
    });

    service.toggleYolo({
      ownerAgentId: "agent_1",
      updatedAt: new Date("2026-03-22T00:00:00.000Z"),
    });
    service.toggleYolo({
      ownerAgentId: "agent_1",
      updatedAt: new Date("2026-03-22T00:10:00.000Z"),
    });

    const row = new AgentRuntimeModesRepo(handle.storage.db).getByOwnerAgentId("agent_1");
    expect(row).toMatchObject({
      yoloEnabled: false,
      yoloSnoozedUntil: new Date(
        new Date("2026-03-22T00:10:00.000Z").getTime() + YOLO_MANUAL_DISABLE_SNOOZE_MS,
      ).toISOString(),
    });
  });
});
