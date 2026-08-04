import type { Readable } from "node:stream";

import { resolveAgentWorkspaceDir } from "@/src/agent/workspace.js";
import {
  FilesystemInboundAttachmentStore,
  type SaveInboundAttachmentInput,
} from "@/src/attachments/store.js";
import type { AvailableAgentUserAttachmentPayload } from "@/src/attachments/types.js";
import { POKOCLAW_WORKSPACE_DIR } from "@/src/shared/paths.js";
import type { StorageDb } from "@/src/storage/db/client.js";
import { AgentsRepo } from "@/src/storage/repos/agents.repo.js";
import { SessionsRepo } from "@/src/storage/repos/sessions.repo.js";

export interface SaveSessionInboundAttachmentInput
  extends Omit<SaveInboundAttachmentInput, "workspaceDir" | "maxBytes" | "resource"> {
  sessionId: string;
  resource: {
    stream: Readable;
    mimeType: string;
    contentLength?: number;
  };
}

export interface SessionInboundAttachmentStore {
  save(input: SaveSessionInboundAttachmentInput): Promise<AvailableAgentUserAttachmentPayload>;
}

export class InboundAttachmentService implements SessionInboundAttachmentStore {
  private readonly fileStore: FilesystemInboundAttachmentStore;
  private readonly workspaceDir: string;

  constructor(
    private readonly deps: {
      storage: StorageDb;
      maxFileBytes: number;
      workspaceDir?: string;
      fileStore?: FilesystemInboundAttachmentStore;
    },
  ) {
    this.fileStore = deps.fileStore ?? new FilesystemInboundAttachmentStore();
    this.workspaceDir = deps.workspaceDir ?? POKOCLAW_WORKSPACE_DIR;
  }

  async save(
    input: SaveSessionInboundAttachmentInput,
  ): Promise<AvailableAgentUserAttachmentPayload> {
    const session = new SessionsRepo(this.deps.storage).getById(input.sessionId);
    if (session?.ownerAgentId == null) {
      input.resource.stream.destroy();
      throw new Error(`Cannot resolve attachment owner for session ${input.sessionId}`);
    }
    const agent = new AgentsRepo(this.deps.storage).getById(session.ownerAgentId);
    if (agent == null) {
      input.resource.stream.destroy();
      throw new Error(`Cannot resolve attachment owner agent ${session.ownerAgentId}`);
    }

    return await this.fileStore.save({
      workspaceDir: resolveAgentWorkspaceDir(agent, this.workspaceDir),
      messageId: input.messageId,
      sourceId: input.sourceId,
      kind: input.kind,
      ...(input.originalName == null ? {} : { originalName: input.originalName }),
      ...(input.createdAt == null ? {} : { createdAt: input.createdAt }),
      resource: input.resource,
      maxBytes: this.deps.maxFileBytes,
    });
  }
}
