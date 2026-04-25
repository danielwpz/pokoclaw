import { describe, expect, test } from "vitest";

import {
  applyThinkTankParticipantReplyFallbackLimit,
  THINK_TANK_PARTICIPANT_REPLY_FALLBACK_MAX_CHARS,
} from "@/src/think-tank/reply-limits.js";
import { buildThinkTankParticipantConsultEnvelope } from "@/src/think-tank/session-runtime.js";

describe("think tank participant reply limits", () => {
  test("keeps normal replies intact", () => {
    const result = applyThinkTankParticipantReplyFallbackLimit({
      reply: "Short but complete.",
    });

    expect(result).toEqual({
      reply: "Short but complete.",
      truncated: false,
      originalCharCount: 19,
      maxChars: THINK_TANK_PARTICIPANT_REPLY_FALLBACK_MAX_CHARS,
    });
  });

  test("truncates only at the fallback safety cap and leaves a marker", () => {
    const result = applyThinkTankParticipantReplyFallbackLimit({
      reply: "x".repeat(THINK_TANK_PARTICIPANT_REPLY_FALLBACK_MAX_CHARS + 50),
    });

    expect(result.truncated).toBe(true);
    expect(result.originalCharCount).toBe(THINK_TANK_PARTICIPANT_REPLY_FALLBACK_MAX_CHARS + 50);
    expect(result.reply.length).toBeLessThanOrEqual(
      THINK_TANK_PARTICIPANT_REPLY_FALLBACK_MAX_CHARS,
    );
    expect(result.reply).toContain("[truncated by system safety limit:");
  });

  test("participant consult envelope uses moderator length budgets instead of a fixed word cap", () => {
    const envelope = buildThinkTankParticipantConsultEnvelope({
      prompt: "Analyze the tradeoff in 600-900 words.",
    });

    expect(envelope).toContain("Follow the moderator's requested response length budget");
    expect(envelope).not.toContain("500 words");
  });
});
