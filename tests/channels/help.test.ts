import { describe, expect, test } from "vitest";
import { buildSlashCommandHelpPresentation } from "@/src/channels/help.js";

describe("slash command help presentation", () => {
  test("renders Lark as markdown with command and usage sections", () => {
    const presentation = buildSlashCommandHelpPresentation("lark");

    expect(presentation.renderMode).toBe("markdown");
    expect(presentation.title).toBe("Slash Commands");
    expect(presentation.summary).toContain("Available slash commands");
    expect(presentation.markdownSections.join("\n")).toContain("/help");
    expect(presentation.markdownSections.join("\n")).toContain("Suggested Usage");
  });

  test("falls back to plain text for non-Lark channels", () => {
    const presentation = buildSlashCommandHelpPresentation("slack");

    expect(presentation.renderMode).toBe("plain_text");
    expect(presentation.plainText).toContain("Slash Commands");
    expect(presentation.plainText).toContain("Rendering: Slack / Plain text");
  });
});
