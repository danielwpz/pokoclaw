export const MAX_INBOUND_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export type UserAttachmentKind = "image" | "file" | "audio" | "video";

export type UnavailableUserAttachmentReason =
  | "too_large"
  | "empty"
  | "download_failed"
  | "unsupported";

export interface AvailableAgentUserAttachmentPayload {
  type: "attachment";
  status: "available";
  kind: UserAttachmentKind;
  name: string;
  localPath: string;
  relativePath: string;
  mimeType: string;
  sizeBytes: number;
}

export interface UnavailableAgentUserAttachmentPayload {
  type: "attachment";
  status: "unavailable";
  kind: UserAttachmentKind;
  name: string;
  reason: UnavailableUserAttachmentReason;
  maxBytes?: number;
}

export type AgentUserAttachmentPayload =
  | AvailableAgentUserAttachmentPayload
  | UnavailableAgentUserAttachmentPayload;
