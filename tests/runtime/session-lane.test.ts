import { afterEach, describe, expect, test, vi } from "vitest";
import type { RunAgentLoopResult } from "@/src/agent/loop.js";
import { InMemorySessionLane } from "@/src/runtime/session-lane.js";
import { MessagesRepo } from "@/src/storage/repos/messages.repo.js";
import { SessionsRepo } from "@/src/storage/repos/sessions.repo.js";
import {
  createTestDatabase,
  destroyTestDatabase,
  type TestDatabaseHandle,
} from "@/tests/storage/helpers/test-db.js";

function seedConversationFixture(handle: TestDatabaseHandle): void {
  handle.storage.sqlite.exec(`
    INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
    VALUES ('ci_1', 'lark', 'acct_a', '2026-03-22T00:00:00.000Z', '2026-03-22T00:00:00.000Z');

    INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
    VALUES ('conv_1', 'ci_1', 'chat_1', 'dm', '2026-03-22T00:00:00.000Z', '2026-03-22T00:00:00.000Z');

    INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
    VALUES ('branch_1', 'conv_1', 'dm_main', 'main', '2026-03-22T00:00:00.000Z', '2026-03-22T00:00:00.000Z');
  `);
}

describe("session lane image normalization", () => {
  let handle: TestDatabaseHandle | null = null;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (handle != null) {
      await destroyTestDatabase(handle);
      handle = null;
    }
  });

  test("extracts legacy inline image data into runtime-only images before starting a run", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationFixture(handle);
    const messages = new MessagesRepo(handle.storage.db);
    const sessions = new SessionsRepo(handle.storage.db);
    sessions.create({
      id: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      purpose: "chat",
      createdAt: new Date("2026-03-22T00:00:00.000Z"),
    });
    const run = vi.fn(
      async (): Promise<RunAgentLoopResult> => ({
        runId: "run_1",
        sessionId: "sess_1",
        scenario: "chat",
        modelId: "model_1",
        appendedMessageIds: [],
        toolExecutions: 0,
        compaction: {
          shouldCompact: false,
          thresholdTokens: 0,
          effectiveWindow: 0,
          reason: null,
        },
        events: [],
        stopSignal: null,
      }),
    );

    const lane = new InMemorySessionLane({
      messages,
      loop: {
        enqueueSteerInput: vi.fn(() => false),
        run,
        submitApprovalResponse: vi.fn(() => false),
      } as never,
    });

    await lane.submitMessage({
      sessionId: "sess_1",
      scenario: "chat",
      content: "[图片 img_v3_123]",
      userPayload: {
        content: "[图片 img_v3_123]",
        images: [
          {
            type: "image",
            id: "img_v3_123",
            messageId: "om_msg_1",
            data: "ZmFrZS1pbWFnZQ==",
            mimeType: "image/png",
          } as never,
        ],
      },
    });

    const rows = messages.listBySession("sess_1");
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]?.payloadJson ?? "{}")).toEqual({
      content: "[图片 img_v3_123]",
      images: [
        {
          type: "image",
          id: "img_v3_123",
          messageId: "om_msg_1",
          mimeType: "image/png",
        },
      ],
    });

    expect(run).toHaveBeenCalledTimes(1);
    const firstRunCall = (
      run as unknown as {
        mock: {
          calls: Array<
            [
              {
                initialRuntimeImagesByMessageId?: Record<string, unknown>;
                sessionId?: string;
                scenario?: string;
              },
            ]
          >;
        };
      }
    ).mock.calls[0];
    expect(firstRunCall).toBeTruthy();
    const firstRunInput = firstRunCall?.[0];
    expect(firstRunInput).toMatchObject({
      sessionId: "sess_1",
      scenario: "chat",
    });
    const initialRuntimeImagesByMessageId = firstRunInput?.initialRuntimeImagesByMessageId;
    expect(initialRuntimeImagesByMessageId).toBeTruthy();
    const messageId = Object.keys(initialRuntimeImagesByMessageId ?? {})[0];
    expect(messageId).toBeTruthy();
    expect(initialRuntimeImagesByMessageId?.[messageId as string]).toEqual([
      {
        type: "image",
        id: "img_v3_123",
        messageId: "om_msg_1",
        data: "ZmFrZS1pbWFnZQ==",
        mimeType: "image/png",
      },
    ]);
  });

  test("extracts legacy inline image data into runtime-only images for steered messages too", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationFixture(handle);
    const messages = new MessagesRepo(handle.storage.db);
    const sessions = new SessionsRepo(handle.storage.db);
    sessions.create({
      id: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      purpose: "chat",
      createdAt: new Date("2026-03-22T00:00:00.000Z"),
    });
    const enqueueSteerInput = vi.fn(() => true);

    const deferredRun = new Promise<RunAgentLoopResult>(() => {});
    const lane = new InMemorySessionLane({
      messages,
      loop: {
        enqueueSteerInput,
        run: vi.fn(() => deferredRun),
        submitApprovalResponse: vi.fn(() => false),
      } as never,
    });

    void lane.submitMessage({
      sessionId: "sess_1",
      scenario: "chat",
      content: "first",
    });

    await lane.submitMessage({
      sessionId: "sess_1",
      scenario: "chat",
      content: "[图片 img_v3_123]",
      userPayload: {
        content: "[图片 img_v3_123]",
        images: [
          {
            type: "image",
            id: "img_v3_123",
            messageId: "om_msg_1",
            data: "ZmFrZS1pbWFnZQ==",
            mimeType: "image/png",
          } as never,
        ],
      },
    });

    expect(enqueueSteerInput).toHaveBeenCalledTimes(1);
    const firstSteerCall = (
      enqueueSteerInput as unknown as {
        mock: { calls: Array<[Record<string, unknown>]> };
      }
    ).mock.calls[0];
    expect(firstSteerCall).toBeTruthy();
    const firstSteerInput = firstSteerCall?.[0];
    expect(firstSteerInput).toMatchObject({
      sessionId: "sess_1",
      content: "[图片 img_v3_123]",
      userPayload: {
        content: "[图片 img_v3_123]",
        images: [
          {
            type: "image",
            id: "img_v3_123",
            messageId: "om_msg_1",
            mimeType: "image/png",
          },
        ],
      },
      runtimeImages: [
        {
          type: "image",
          id: "img_v3_123",
          messageId: "om_msg_1",
          data: "ZmFrZS1pbWFnZQ==",
          mimeType: "image/png",
        },
      ],
    });
  });
});
