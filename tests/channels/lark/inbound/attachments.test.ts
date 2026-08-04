import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { AgentUserPayload, AgentUserRuntimeImagePayload } from "@/src/agent/llm/messages.js";
import type { LarkSdkClient } from "@/src/channels/lark/client.js";
import {
  buildLarkChatSurfaceKey,
  createLarkMessageReceiveHandler,
} from "@/src/channels/lark/inbound.js";
import { extractLarkInboundAttachmentDescriptors } from "@/src/channels/lark/inbound-attachments.js";
import { InboundAttachmentService } from "@/src/orchestration/inbound-attachments.js";
import { SessionRunAbortRegistry } from "@/src/runtime/cancel.js";
import { RuntimeControlService } from "@/src/runtime/control.js";
import { ChannelSurfacesRepo } from "@/src/storage/repos/channel-surfaces.repo.js";
import { makeMessageEvent, seedFixture, withHandle } from "./fixtures.js";

interface SubmittedMessage {
  userPayload?: AgentUserPayload;
  runtimeImages?: AgentUserRuntimeImagePayload[];
}

describe("lark inbound attachments", () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(path.join(os.tmpdir(), "pokoclaw-lark-attachments-"));
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  test("extracts file, audio, video, and rich-post resources with the correct API type", () => {
    expect(
      extractLarkInboundAttachmentDescriptors(
        "file",
        JSON.stringify({ file_key: "file_1", file_name: "notes.md" }),
      ),
    ).toEqual([
      {
        kind: "file",
        resourceKey: "file_1",
        resourceType: "file",
        originalName: "notes.md",
      },
    ]);
    expect(
      extractLarkInboundAttachmentDescriptors("audio", JSON.stringify({ file_key: "audio_1" })),
    ).toEqual([{ kind: "audio", resourceKey: "audio_1", resourceType: "file" }]);
    expect(
      extractLarkInboundAttachmentDescriptors(
        "media",
        JSON.stringify({ file_key: "video_1", file_name: "demo.mp4" }),
      ),
    ).toEqual([
      {
        kind: "video",
        resourceKey: "video_1",
        resourceType: "file",
        originalName: "demo.mp4",
      },
    ]);
    expect(
      extractLarkInboundAttachmentDescriptors(
        "post",
        JSON.stringify({
          zh_cn: {
            content: [
              [
                { tag: "img", image_key: "image_1" },
                { tag: "file", file_key: "file_2", file_name: "brief.pdf" },
                { tag: "img", image_key: "image_1" },
              ],
            ],
          },
        }),
      ),
    ).toEqual([
      { kind: "image", resourceKey: "image_1", resourceType: "image" },
      {
        kind: "file",
        resourceKey: "file_2",
        resourceType: "file",
        originalName: "brief.pdf",
      },
    ]);
  });

  test("downloads a file through the SDK and persists it in the session owner's workspace", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);
      seedSurface(handle.storage.db);
      const body = Buffer.from("# product brief");
      const messageResourceGet = vi.fn(async (_input: unknown) => ({
        headers: {
          "Content-Type": "text/markdown; charset=utf-8",
          "Content-Length": String(body.length),
        },
        getReadableStream: () => Readable.from(body),
      }));
      const submitMessage = vi.fn(async (_input: unknown) => ({ status: "started" as const }));
      const handler = createLarkMessageReceiveHandler({
        installationId: "default",
        storage: handle.storage.db,
        ingress: { submitMessage, submitApprovalDecision: vi.fn(() => false) },
        control: new RuntimeControlService(new SessionRunAbortRegistry()),
        clients: createClients(messageResourceGet),
        attachmentStore: new InboundAttachmentService({
          storage: handle.storage.db,
          maxFileBytes: 20 * 1024 * 1024,
          workspaceDir,
        }),
      });

      await handler(
        makeMessageEvent("file", {
          file_key: "file_v3_notes",
          file_name: "../../产品 需求.md",
        }),
      );

      expect(messageResourceGet).toHaveBeenCalledExactlyOnceWith({
        path: { message_id: "om_msg_1", file_key: "file_v3_notes" },
        params: { type: "file" },
      });
      const submitted = submitMessage.mock.calls[0]?.[0] as SubmittedMessage;
      const attachment = submitted.userPayload?.attachments?.[0];
      expect(attachment).toMatchObject({
        type: "attachment",
        status: "available",
        kind: "file",
        name: "产品-需求.md",
        mimeType: "text/markdown",
        sizeBytes: body.length,
      });
      expect(attachment?.status).toBe("available");
      if (attachment?.status !== "available") {
        throw new Error("expected available attachment");
      }
      expect(attachment.localPath).toMatch(
        new RegExp(
          `${escapeRegExp(workspaceDir)}/uploads/2026-03-27/om_msg_1/产品-需求--[a-f0-9]{8}\\.md$`,
        ),
      );
      expect(await readFile(attachment.localPath)).toEqual(body);
    });
  });

  test("persists images while preserving the existing first-turn vision payload", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);
      seedSurface(handle.storage.db);
      const body = Buffer.from("image-body");
      const messageResourceGet = vi.fn(async (_input: unknown) => ({
        headers: { "content-type": "image/png", "content-length": String(body.length) },
        getReadableStream: () => Readable.from(body),
      }));
      const submitMessage = vi.fn(async (_input: unknown) => ({ status: "started" as const }));
      const handler = createLarkMessageReceiveHandler({
        installationId: "default",
        storage: handle.storage.db,
        ingress: { submitMessage, submitApprovalDecision: vi.fn(() => false) },
        control: new RuntimeControlService(new SessionRunAbortRegistry()),
        clients: createClients(messageResourceGet),
        attachmentStore: new InboundAttachmentService({
          storage: handle.storage.db,
          maxFileBytes: 20 * 1024 * 1024,
          workspaceDir,
        }),
      });

      await handler(makeMessageEvent("image", { image_key: "img_v3_saved" }));

      expect(messageResourceGet.mock.calls[0]?.[0]).toMatchObject({ params: { type: "image" } });
      const submitted = submitMessage.mock.calls[0]?.[0] as SubmittedMessage;
      expect(submitted.runtimeImages).toEqual([
        {
          type: "image",
          id: "img_v3_saved",
          messageId: "om_msg_1",
          data: body.toString("base64"),
          mimeType: "image/png",
        },
      ]);
      expect(submitted.userPayload?.images).toEqual([
        {
          type: "image",
          id: "img_v3_saved",
          messageId: "om_msg_1",
          mimeType: "image/png",
        },
      ]);
      const attachment = submitted.userPayload?.attachments?.[0];
      expect(attachment).toMatchObject({
        status: "available",
        kind: "image",
        name: "image.png",
        mimeType: "image/png",
      });
      if (attachment?.status !== "available") {
        throw new Error("expected available image attachment");
      }
      expect(await readFile(attachment.localPath)).toEqual(body);
    });
  });

  test("reports files above the configured limit without persisting them", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);
      seedSurface(handle.storage.db);
      const messageResourceGet = vi.fn(async (_input: unknown) => ({
        headers: { "content-type": "audio/ogg", "content-length": "10" },
        getReadableStream: () => Readable.from(Buffer.alloc(10)),
      }));
      const submitMessage = vi.fn(async (_input: unknown) => ({ status: "started" as const }));
      const handler = createLarkMessageReceiveHandler({
        installationId: "default",
        storage: handle.storage.db,
        ingress: { submitMessage, submitApprovalDecision: vi.fn(() => false) },
        control: new RuntimeControlService(new SessionRunAbortRegistry()),
        clients: createClients(messageResourceGet),
        attachmentStore: new InboundAttachmentService({
          storage: handle.storage.db,
          maxFileBytes: 5,
          workspaceDir,
        }),
      });

      await handler(makeMessageEvent("audio", { file_key: "audio_v3_large" }));

      expect(messageResourceGet.mock.calls[0]?.[0]).toMatchObject({ params: { type: "file" } });
      const submitted = submitMessage.mock.calls[0]?.[0] as SubmittedMessage;
      expect(submitted.userPayload?.attachments).toEqual([
        {
          type: "attachment",
          status: "unavailable",
          kind: "audio",
          name: "audio.ogg",
          reason: "too_large",
          maxBytes: 5,
        },
      ]);
      expect(submitted.runtimeImages).toBeUndefined();
    });
  });
});

function seedSurface(storage: ConstructorParameters<typeof ChannelSurfacesRepo>[0]): void {
  new ChannelSurfacesRepo(storage).upsert({
    id: "surface_1",
    channelType: "lark",
    channelInstallationId: "default",
    conversationId: "conv_main",
    branchId: "branch_main",
    surfaceKey: buildLarkChatSurfaceKey("oc_chat_1"),
    surfaceObjectJson: JSON.stringify({ chat_id: "oc_chat_1" }),
  });
}

function createClients(messageResourceGet: ReturnType<typeof vi.fn>) {
  return {
    getOrCreate: vi.fn(() => ({
      sdk: {
        im: {
          messageResource: {
            get: messageResourceGet,
          },
        },
      },
    })),
  } as unknown as { getOrCreate(installationId: string): LarkSdkClient };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
