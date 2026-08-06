import { mkdtemp, readdir, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, test } from "vitest";

import { resolveAgentWorkspaceDir } from "@/src/agent/workspace.js";
import {
  buildInboundAttachmentShortHash,
  FilesystemInboundAttachmentStore,
  type InboundAttachmentStoreError,
} from "@/src/attachments/store.js";

describe("filesystem inbound attachment store", () => {
  const temporaryDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  test("normalizes the original name, appends an 8-character stable hash, and saves atomically", async () => {
    const workspaceDir = await createTemporaryWorkspace(temporaryDirs);
    const sourceId = "lark:default:om_msg_1:file:file_key_1";
    const stored = await new FilesystemInboundAttachmentStore().save({
      workspaceDir,
      messageId: "om/msg?1",
      sourceId,
      kind: "file",
      originalName: "../../财务 报告?.PDF",
      createdAt: new Date("2026-08-04T10:00:00.000Z"),
      resource: {
        stream: Readable.from(Buffer.from("pdf-body")),
        mimeType: "application/pdf",
        contentLength: 8,
      },
      maxBytes: 1_024,
    });

    const shortHash = buildInboundAttachmentShortHash(sourceId);
    expect(stored).toMatchObject({
      type: "attachment",
      status: "available",
      kind: "file",
      name: "财务-报告.PDF",
      relativePath: path.join("uploads", "2026-08-04", "om-msg-1", `财务-报告--${shortHash}.PDF`),
      mimeType: "application/pdf",
      sizeBytes: 8,
    });
    expect(await readFile(stored.localPath, "utf8")).toBe("pdf-body");
    expect(
      (await readdir(path.dirname(stored.localPath))).some((name) => name.endsWith(".part")),
    ).toBe(false);
  });

  test("reuses the deterministic destination for duplicate deliveries", async () => {
    const workspaceDir = await createTemporaryWorkspace(temporaryDirs);
    const store = new FilesystemInboundAttachmentStore();
    const baseInput = {
      workspaceDir,
      messageId: "om_msg_1",
      sourceId: "lark:default:om_msg_1:file:file_key_1",
      kind: "file" as const,
      originalName: "notes.md",
      createdAt: new Date("2026-08-04T10:00:00.000Z"),
      maxBytes: 1_024,
    };
    const first = await store.save({
      ...baseInput,
      resource: {
        stream: Readable.from(Buffer.from("first")),
        mimeType: "text/markdown",
      },
    });
    const second = await store.save({
      ...baseInput,
      resource: {
        stream: Readable.from(Buffer.from("second")),
        mimeType: "text/markdown",
      },
    });

    expect(second.localPath).toBe(first.localPath);
    expect(second.sizeBytes).toBe(first.sizeBytes);
    expect(await readFile(first.localPath, "utf8")).toBe("first");
  });

  test("replaces an existing destination whose size differs from the declared content length", async () => {
    const workspaceDir = await createTemporaryWorkspace(temporaryDirs);
    const store = new FilesystemInboundAttachmentStore();
    const baseInput = {
      workspaceDir,
      messageId: "om_msg_1",
      sourceId: "lark:default:om_msg_1:file:file_key_1",
      kind: "file" as const,
      originalName: "notes.md",
      createdAt: new Date("2026-08-04T10:00:00.000Z"),
      maxBytes: 1_024,
    };
    const first = await store.save({
      ...baseInput,
      resource: {
        stream: Readable.from(Buffer.from("first")),
        mimeType: "text/markdown",
      },
    });
    const second = await store.save({
      ...baseInput,
      resource: {
        stream: Readable.from(Buffer.from("second")),
        mimeType: "text/markdown",
        contentLength: 6,
      },
    });

    expect(second.localPath).toBe(first.localPath);
    expect(second.sizeBytes).toBe(6);
    expect(await readFile(first.localPath, "utf8")).toBe("second");
  });

  test("rejects streams that cross the byte limit and removes partial files", async () => {
    const workspaceDir = await createTemporaryWorkspace(temporaryDirs);
    const save = new FilesystemInboundAttachmentStore().save({
      workspaceDir,
      messageId: "om_msg_1",
      sourceId: "lark:default:om_msg_1:file:file_key_large",
      kind: "file",
      originalName: "large.bin",
      createdAt: new Date("2026-08-04T10:00:00.000Z"),
      resource: {
        stream: Readable.from([Buffer.alloc(6), Buffer.alloc(6)]),
        mimeType: "application/octet-stream",
      },
      maxBytes: 10,
    });

    await expect(save).rejects.toMatchObject({
      reason: "too_large",
      maxBytes: 10,
    } satisfies Partial<InboundAttachmentStoreError>);
    const files = await readdir(workspaceDir, { recursive: true });
    expect(files.some((name) => name.endsWith(".part"))).toBe(false);
    expect(files.some((name) => name.endsWith(".bin"))).toBe(false);
  });

  test("rejects streams whose byte length does not match the declared content length", async () => {
    const workspaceDir = await createTemporaryWorkspace(temporaryDirs);
    const save = new FilesystemInboundAttachmentStore().save({
      workspaceDir,
      messageId: "om_msg_1",
      sourceId: "lark:default:om_msg_1:file:file_key_truncated",
      kind: "file",
      originalName: "truncated.bin",
      createdAt: new Date("2026-08-04T10:00:00.000Z"),
      resource: {
        stream: Readable.from(Buffer.from("short")),
        mimeType: "application/octet-stream",
        contentLength: 10,
      },
      maxBytes: 1_024,
    });

    await expect(save).rejects.toMatchObject({
      reason: "download_failed",
    } satisfies Partial<InboundAttachmentStoreError>);
    const files = await readdir(workspaceDir, { recursive: true });
    expect(files.some((name) => name.endsWith(".part"))).toBe(false);
    expect(files.some((name) => name.endsWith(".bin"))).toBe(false);
  });

  test("rejects an uploads symlink that escapes the workspace", async () => {
    const workspaceDir = await createTemporaryWorkspace(temporaryDirs);
    const outsideDir = await createTemporaryWorkspace(temporaryDirs);
    await symlink(outsideDir, path.join(workspaceDir, "uploads"), "dir");

    const save = new FilesystemInboundAttachmentStore().save({
      workspaceDir,
      messageId: "om_msg_1",
      sourceId: "lark:default:om_msg_1:file:file_key_escape",
      kind: "file",
      originalName: "escape.txt",
      createdAt: new Date("2026-08-04T10:00:00.000Z"),
      resource: {
        stream: Readable.from(Buffer.from("must-stay-inside")),
        mimeType: "text/plain",
        contentLength: 16,
      },
      maxBytes: 1_024,
    });

    await expect(save).rejects.toMatchObject({
      reason: "download_failed",
    } satisfies Partial<InboundAttachmentStoreError>);
    expect(await readdir(outsideDir, { recursive: true })).toEqual([]);
  });

  test("uses the shared workspace for main agents and the private workspace for subagents", () => {
    expect(
      resolveAgentWorkspaceDir({ id: "main-id", kind: "main" }, "/tmp/pokoclaw-workspace"),
    ).toBe("/tmp/pokoclaw-workspace");
    expect(
      resolveAgentWorkspaceDir({ id: "ABCD-1234-efgh", kind: "sub" }, "/tmp/pokoclaw-workspace"),
    ).toBe("/tmp/pokoclaw-workspace/subagents/abcd1234");
  });
});

async function createTemporaryWorkspace(temporaryDirs: string[]): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pokoclaw-attachments-test-"));
  temporaryDirs.push(dir);
  return dir;
}
