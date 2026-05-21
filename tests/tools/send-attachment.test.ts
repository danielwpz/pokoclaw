import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { DEFAULT_CONFIG } from "@/src/config/defaults.js";
import { SecurityService } from "@/src/security/service.js";
import { ToolRegistry } from "@/src/tools/core/registry.js";
import { createSendAttachmentTool } from "@/src/tools/send-attachment.js";
import {
  createTestDatabase,
  destroyTestDatabase,
  type TestDatabaseHandle,
} from "@/tests/storage/helpers/test-db.js";
import {
  resolveExpectedToolAbsolutePath,
  seedConversationAndAgentFixture,
} from "@/tests/tools/helpers.js";

describe("send_attachment tool", () => {
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

  test("describes native attachment delivery instead of fallback links or cards", () => {
    const tool = createSendAttachmentTool();

    expect(tool.description).toContain("send, show, share, or deliver a local image or file");
    expect(tool.description).toContain("current conversation");
    expect(tool.description).toContain("Do not substitute Markdown links");
    expect(tool.description).toContain("text cards, or A2UI");
  });

  test("publishes a granted local image path as a channel-neutral outbound attachment request", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    handle.storage.sqlite.exec(`
      INSERT INTO sessions (id, conversation_id, branch_id, owner_agent_id, purpose, created_at, updated_at)
      VALUES ('sess_1', 'conv_1', 'branch_1', 'agent_1', 'chat', '2026-03-22T00:00:00.000Z', '2026-03-22T00:00:00.000Z');
    `);

    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokoclaw-send-attachment-"));
    const attachmentPath = path.join(tempDir, "chart.png");
    await writeFile(attachmentPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    new SecurityService(handle.storage.db).grantScopes({
      ownerAgentId: "agent_1",
      grantedBy: "main_agent",
      scopes: [{ kind: "fs.read", path: `${tempDir}/**` }],
    });

    const sendAttachment = vi.fn(async () => ({
      accepted: true as const,
      eventId: "evt_image_1",
    }));
    const registry = new ToolRegistry();
    registry.register(createSendAttachmentTool());

    const result = await registry.execute(
      "send_attachment",
      {
        sessionId: "sess_1",
        conversationId: "conv_1",
        ownerAgentId: "agent_1",
        cwd: tempDir,
        securityConfig: DEFAULT_CONFIG.security,
        storage: handle.storage.db,
        runtimeControl: {
          sendAttachment,
          submitApprovalDecision: vi.fn(() => false),
        },
      },
      { path: "chart.png", type: "image" },
    );

    const expectedAbsolutePath = await resolveExpectedToolAbsolutePath(attachmentPath);
    expect(sendAttachment).toHaveBeenCalledWith({
      sourceSessionId: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      attachmentPath: expectedAbsolutePath,
      displayPath: "chart.png",
      type: "image",
    });
    expect(result).toEqual({
      content: [{ type: "text", text: "Queued attachment chart.png for sending." }],
      details: {
        path: "chart.png",
        absolutePath: expectedAbsolutePath,
        type: "image",
        eventId: "evt_image_1",
        queued: true,
      },
    });
  });
});
