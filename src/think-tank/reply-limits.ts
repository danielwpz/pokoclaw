export const THINK_TANK_PARTICIPANT_REPLY_FALLBACK_MAX_CHARS = 3_000;

export interface ThinkTankParticipantReplyLimitResult {
  reply: string;
  truncated: boolean;
  originalCharCount: number;
  maxChars: number;
}

export function applyThinkTankParticipantReplyFallbackLimit(input: {
  reply: string;
  maxChars?: number;
}): ThinkTankParticipantReplyLimitResult {
  const maxChars = normalizeMaxChars(
    input.maxChars ?? THINK_TANK_PARTICIPANT_REPLY_FALLBACK_MAX_CHARS,
  );
  const characters = Array.from(input.reply);
  if (characters.length <= maxChars) {
    return {
      reply: input.reply,
      truncated: false,
      originalCharCount: characters.length,
      maxChars,
    };
  }

  const notice = `\n\n[truncated by system safety limit: original reply was ${String(
    characters.length,
  )} characters; ask this participant for a shorter follow-up if more detail is needed]`;
  const noticeCharacters = Array.from(notice);
  const contentMaxChars = Math.max(0, maxChars - noticeCharacters.length);
  const visibleContent = characters.slice(0, contentMaxChars).join("").trimEnd();

  return {
    reply:
      noticeCharacters.length >= maxChars
        ? noticeCharacters.slice(0, maxChars).join("")
        : `${visibleContent}${notice}`,
    truncated: true,
    originalCharCount: characters.length,
    maxChars,
  };
}

function normalizeMaxChars(value: number): number {
  if (!Number.isFinite(value) || Number.isNaN(value)) {
    return THINK_TANK_PARTICIPANT_REPLY_FALLBACK_MAX_CHARS;
  }
  return Math.max(1, Math.trunc(value));
}
