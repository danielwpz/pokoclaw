import { describe, expect, test } from "vitest";
import { buildSlashCommandHelpPresentation } from "@/src/channels/help.js";

describe("slash command help presentation", () => {
  test("renders Lark as markdown with the requested command list", () => {
    const presentation = buildSlashCommandHelpPresentation("lark");

    expect(presentation.renderMode).toBe("markdown");
    expect(presentation.title).toBe("Slash Commands");
    expect(presentation.markdownSections.join("\n")).toBe(
      [
        "### Slash Commands",
        "- /help — Show this help message.",
        "- /status — Show the current conversation status, model, usage, and active runs.",
        "- /model — Open the model switch card for the current conversation.",
        "- /stop — Stop the current conversation or session.",
      ].join("\n"),
    );
  });

  test("falls back to plain text for non-Lark channels", () => {
    const presentation = buildSlashCommandHelpPresentation("slack");

    expect(presentation.renderMode).toBe("plain_text");
    expect(presentation.plainText).toContain("Slash Commands");
    expect(presentation.plainText).toContain("/status");
    expect(presentation.plainText).toContain("Channel: Slack");
  });
});
