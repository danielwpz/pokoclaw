import type { AssistantResponseRetryingEvent } from "@/src/agent/events.js";

export interface LarkRetryFooterNotice {
  kind: "assistant_response_retrying";
  attempt: number;
  maxAttempts: number;
}

export function createLarkRetryFooterNotice(
  event: AssistantResponseRetryingEvent,
): LarkRetryFooterNotice {
  return {
    kind: "assistant_response_retrying",
    attempt: event.attempt,
    maxAttempts: event.maxAttempts,
  };
}

export function renderLarkRetryFooterNotice(notice: LarkRetryFooterNotice): string {
  return `🔁 模型调用出错，正在重试 ${notice.attempt}/${notice.maxAttempts}`;
}

export function summarizeLarkRetryFooterNotice(notice: LarkRetryFooterNotice): string {
  return renderLarkRetryFooterNotice(notice);
}
