import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";
import { DEFAULT_CONFIG } from "@/src/config/defaults.js";
import { SecurityService } from "@/src/security/service.js";
import type { ToolFailure } from "@/src/tools/core/errors.js";
import { ToolRegistry } from "@/src/tools/core/registry.js";
import { createFinishTaskTool } from "@/src/tools/finish-task.js";
import {
  createTestDatabase,
  destroyTestDatabase,
  type TestDatabaseHandle,
} from "@/tests/storage/helpers/test-db.js";
import {
  resolveExpectedToolAbsolutePath,
  seedConversationAndAgentFixture,
} from "@/tests/tools/helpers.js";

describe("finish_task tool", () => {
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

  test("records explicit task completion details for unattended task sessions", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    handle.storage.sqlite.exec(`
      INSERT INTO sessions (
        id, conversation_id, branch_id, owner_agent_id, purpose, status, created_at, updated_at
      ) VALUES (
        'sess_task', 'conv_1', 'branch_1', 'agent_1', 'task', 'active',
        '2026-03-30T00:00:00.000Z', '2026-03-30T00:00:00.000Z'
      );
    `);

    const registry = new ToolRegistry([createFinishTaskTool()]);
    const result = await registry.execute(
      "finish_task",
      {
        sessionId: "sess_task",
        conversationId: "conv_1",
        ownerAgentId: "agent_1",
        securityConfig: DEFAULT_CONFIG.security,
        storage: handle.storage.db,
      },
      {
        status: "blocked",
        summary: "Waiting for an external deployment window.",
        finalMessage: "Task is blocked until the external deployment window opens.",
      },
    );

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: "Recorded task completion with status=blocked.",
        },
      ],
      details: {
        taskCompletion: {
          status: "blocked",
          summary: "Waiting for an external deployment window.",
          finalMessage: "Task is blocked until the external deployment window opens.",
        },
      },
    });
  });

  test("records local finish images for unattended task sessions", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    handle.storage.sqlite.exec(`
      INSERT INTO sessions (
        id, conversation_id, branch_id, owner_agent_id, purpose, status, created_at, updated_at
      ) VALUES (
        'sess_task', 'conv_1', 'branch_1', 'agent_1', 'task', 'active',
        '2026-03-30T00:00:00.000Z', '2026-03-30T00:00:00.000Z'
      );
    `);

    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokoclaw-finish-task-"));
    const imagePath = path.join(tempDir, "chart.png");
    await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    new SecurityService(handle.storage.db).grantScopes({
      ownerAgentId: "agent_1",
      grantedBy: "main_agent",
      scopes: [{ kind: "fs.read", path: `${tempDir}/**` }],
    });

    const registry = new ToolRegistry([createFinishTaskTool()]);
    const result = await registry.execute(
      "finish_task",
      {
        sessionId: "sess_task",
        conversationId: "conv_1",
        ownerAgentId: "agent_1",
        cwd: tempDir,
        securityConfig: DEFAULT_CONFIG.security,
        storage: handle.storage.db,
      },
      {
        status: "completed",
        summary: "Chart generated.",
        finalMessage: "Generated the final chart.",
        images: [{ path: "chart.png", alt: "Completion chart" }],
      },
    );

    expect(result.details).toMatchObject({
      taskCompletion: {
        status: "completed",
        summary: "Chart generated.",
        finalMessage: "Generated the final chart.",
        images: [
          {
            path: await resolveExpectedToolAbsolutePath(imagePath),
            displayPath: "chart.png",
            alt: "Completion chart",
          },
        ],
      },
    });
  });

  test("reports all missing finish image read permissions together", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    handle.storage.sqlite.exec(`
      INSERT INTO sessions (
        id, conversation_id, branch_id, owner_agent_id, purpose, status, created_at, updated_at
      ) VALUES (
        'sess_task', 'conv_1', 'branch_1', 'agent_1', 'task', 'active',
        '2026-03-30T00:00:00.000Z', '2026-03-30T00:00:00.000Z'
      );
    `);

    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokoclaw-finish-task-"));
    const firstImagePath = path.join(tempDir, "first.png");
    const secondImagePath = path.join(tempDir, "second.png");
    await writeFile(firstImagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(secondImagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const registry = new ToolRegistry([createFinishTaskTool()]);
    await expect(
      registry.execute(
        "finish_task",
        {
          sessionId: "sess_task",
          conversationId: "conv_1",
          ownerAgentId: "agent_1",
          cwd: tempDir,
          securityConfig: DEFAULT_CONFIG.security,
          storage: handle.storage.db,
        },
        {
          status: "completed",
          summary: "Charts generated.",
          finalMessage: "Generated the final charts.",
          images: [{ path: "first.png" }, { path: "second.png" }],
        },
      ),
    ).rejects.toMatchObject({
      name: "ToolFailure",
      kind: "recoverable_error",
      details: {
        code: "permission_denied",
        requestable: true,
        entries: expect.arrayContaining([
          expect.objectContaining({
            path: await resolveExpectedToolAbsolutePath(firstImagePath),
          }),
          expect.objectContaining({
            path: await resolveExpectedToolAbsolutePath(secondImagePath),
          }),
        ]),
      },
    } satisfies Partial<ToolFailure>);
  });

  test("rejects finish_task outside unattended task sessions", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    handle.storage.sqlite.exec(`
      INSERT INTO sessions (
        id, conversation_id, branch_id, owner_agent_id, purpose, status, created_at, updated_at
      ) VALUES (
        'sess_chat', 'conv_1', 'branch_1', 'agent_1', 'chat', 'active',
        '2026-03-30T00:00:00.000Z', '2026-03-30T00:00:00.000Z'
      );
    `);

    const registry = new ToolRegistry([createFinishTaskTool()]);

    await expect(
      registry.execute(
        "finish_task",
        {
          sessionId: "sess_chat",
          conversationId: "conv_1",
          ownerAgentId: "agent_1",
          securityConfig: DEFAULT_CONFIG.security,
          storage: handle.storage.db,
        },
        {
          status: "completed",
          summary: "Done.",
          finalMessage: "Done.",
        },
      ),
    ).rejects.toMatchObject({
      name: "ToolFailure",
      kind: "recoverable_error",
      details: {
        code: "finish_task_wrong_session_purpose",
        sessionId: "sess_chat",
        sessionPurpose: "chat",
      },
    } satisfies Partial<ToolFailure>);
  });
});
