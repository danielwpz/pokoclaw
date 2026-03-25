import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { DEFAULT_CONFIG } from "@/src/config/defaults.js";
import { SecurityService } from "@/src/security/service.js";
import { MessagesRepo } from "@/src/storage/repos/messages.repo.js";
import { SessionsRepo } from "@/src/storage/repos/sessions.repo.js";
import type { ToolApprovalRequired, ToolFailure } from "@/src/tools/core/errors.js";
import { ToolRegistry } from "@/src/tools/core/registry.js";
import { createRequestPermissionsTool } from "@/src/tools/request-permissions.js";
import {
  createTestDatabase,
  destroyTestDatabase,
  type TestDatabaseHandle,
} from "@/tests/storage/helpers/test-db.js";
import { seedConversationAndAgentFixture } from "@/tests/tools/helpers.js";

describe("request_permissions tool", () => {
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

  test("returns already_granted when the requested path is already allowed", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokeclaw-request-perms-"));

    const targetPath = path.join(tempDir, "notes.txt");
    const security = new SecurityService(handle.storage.db);
    security.grantScopes({
      ownerAgentId: "agent_1",
      grantedBy: "main_agent",
      scopes: [
        { kind: "fs.read", path: targetPath },
        { kind: "fs.write", path: targetPath },
      ],
    });

    const registry = new ToolRegistry([createRequestPermissionsTool()]);
    const result = await registry.execute(
      "request_permissions",
      {
        sessionId: "sess_1",
        conversationId: "conv_1",
        ownerAgentId: "agent_1",
        cwd: tempDir,
        securityConfig: DEFAULT_CONFIG.security,
        storage: handle.storage.db,
      },
      {
        entries: [
          {
            resource: "filesystem",
            path: targetPath,
            scope: "exact",
            access: "read_write",
          },
        ],
        justification: "Need to update the requested file.",
      },
    );

    expect(result).toEqual({
      content: [{ type: "text", text: "Requested permissions are already granted." }],
      details: {
        kind: "permission_request_result",
        status: "already_granted",
        entries: [
          {
            resource: "filesystem",
            path: targetPath,
            scope: "exact",
            access: "read_write",
          },
        ],
        justification: "Need to update the requested file.",
      },
    });
  });

  test("rejects relative paths", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokeclaw-request-perms-"));

    const registry = new ToolRegistry([createRequestPermissionsTool()]);

    await expect(
      registry.execute(
        "request_permissions",
        {
          sessionId: "sess_1",
          conversationId: "conv_1",
          ownerAgentId: "agent_1",
          cwd: tempDir,
          securityConfig: DEFAULT_CONFIG.security,
          storage: handle.storage.db,
        },
        {
          entries: [
            {
              resource: "filesystem",
              path: "notes.txt",
              scope: "exact",
              access: "write",
            },
          ],
          justification: "Need to write the requested file.",
        },
      ),
    ).rejects.toMatchObject({
      name: "ToolFailure",
      kind: "recoverable_error",
      details: {
        code: "permission_request_path_not_absolute",
        path: "notes.txt",
      },
    } satisfies Partial<ToolFailure>);
  });

  test("rejects retryToolCallId when it is not the latest permission-blocked tool result", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokeclaw-request-perms-"));

    const sessions = new SessionsRepo(handle.storage.db);
    sessions.create({
      id: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      ownerAgentId: "agent_1",
      purpose: "chat",
      createdAt: new Date("2026-03-24T00:00:00.000Z"),
    });

    const messages = new MessagesRepo(handle.storage.db);
    messages.append({
      id: "msg_tool",
      sessionId: "sess_1",
      seq: 1,
      role: "tool",
      messageType: "tool_result",
      visibility: "hidden_system",
      payloadJson: JSON.stringify({
        toolCallId: "tool_other",
        toolName: "read",
        content: [{ type: "text", text: "blocked" }],
        isError: true,
        details: {
          code: "permission_denied",
          requestable: true,
          summary: "Read access is missing.",
          entries: [
            {
              resource: "filesystem",
              path: "/tmp/other.txt",
              scope: "exact",
              access: "read",
            },
          ],
        },
      }),
      createdAt: new Date("2026-03-24T00:00:00.000Z"),
    });

    const registry = new ToolRegistry([createRequestPermissionsTool()]);

    await expect(
      registry.execute(
        "request_permissions",
        {
          sessionId: "sess_1",
          conversationId: "conv_1",
          ownerAgentId: "agent_1",
          cwd: tempDir,
          securityConfig: DEFAULT_CONFIG.security,
          storage: handle.storage.db,
        },
        {
          entries: [
            {
              resource: "filesystem",
              path: "/tmp/notes.txt",
              scope: "exact",
              access: "write",
            },
          ],
          justification: "Need to write the requested file.",
          retryToolCallId: "tool_1",
        },
      ),
    ).rejects.toMatchObject({
      name: "ToolFailure",
      kind: "recoverable_error",
      details: {
        code: "invalid_retry_tool_call_id",
        retryToolCallId: "tool_1",
      },
    } satisfies Partial<ToolFailure>);
  });

  test("raises ToolApprovalRequired for a valid new permission request", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokeclaw-request-perms-"));

    const registry = new ToolRegistry([createRequestPermissionsTool()]);

    await expect(
      registry.execute(
        "request_permissions",
        {
          sessionId: "sess_1",
          conversationId: "conv_1",
          ownerAgentId: "agent_1",
          cwd: tempDir,
          securityConfig: DEFAULT_CONFIG.security,
          storage: handle.storage.db,
        },
        {
          entries: [
            {
              resource: "filesystem",
              path: "/tmp/requested.txt",
              scope: "exact",
              access: "write",
            },
          ],
          justification: "Need to write the requested file.",
        },
      ),
    ).rejects.toMatchObject({
      name: "ToolApprovalRequired",
      reasonText: "Need to write the requested file.",
      request: {
        scopes: [{ kind: "fs.write", path: "/tmp/requested.txt" }],
      },
    } satisfies Partial<ToolApprovalRequired>);
  });

  test("accepts a long justification without an arbitrary max length cap", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokeclaw-request-perms-"));

    const registry = new ToolRegistry([createRequestPermissionsTool()]);
    const longJustification =
      "Need temporary read access to this exact file because the current task is blocked on checking the data shape, " +
      "and the approval record should preserve enough context for later audit, review, and debugging if the user asks " +
      "why the delegated agent requested this scope in the first place.";

    await expect(
      registry.execute(
        "request_permissions",
        {
          sessionId: "sess_1",
          conversationId: "conv_1",
          ownerAgentId: "agent_1",
          cwd: tempDir,
          securityConfig: DEFAULT_CONFIG.security,
          storage: handle.storage.db,
        },
        {
          entries: [
            {
              resource: "filesystem",
              path: "/tmp/requested.txt",
              scope: "exact",
              access: "read",
            },
          ],
          justification: longJustification,
        },
      ),
    ).rejects.toMatchObject({
      name: "ToolApprovalRequired",
      reasonText: longJustification,
      request: {
        scopes: [{ kind: "fs.read", path: "/tmp/requested.txt" }],
      },
    } satisfies Partial<ToolApprovalRequired>);
  });
});
