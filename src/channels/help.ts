export type SlashCommandHelpRenderMode = "markdown" | "plain_text";

export interface SlashCommandHelpPresentation {
  title: string;
  summary: string;
  renderMode: SlashCommandHelpRenderMode;
  markdownSections: string[];
  plainText: string;
}

interface SlashCommandHelpEntry {
  command: string;
  description: string;
  suggestedUse: string;
}

const SLASH_COMMANDS: SlashCommandHelpEntry[] = [
  {
    command: "/help",
    description: "Show this help message.",
    suggestedUse: "Use it when you want a quick reminder of what the assistant can do.",
  },
  {
    command: "/status",
    description: "Show the current conversation status, model, usage, and active runs.",
    suggestedUse: "Use it when you want to check progress before continuing work.",
  },
  {
    command: "/model",
    description: "Open the model switch card for the current conversation.",
    suggestedUse: "Use it when you want to inspect or change the active model.",
  },
  {
    command: "/stop",
    description: "Stop the current conversation or session.",
    suggestedUse: "Use it when the current run is off track or should be interrupted immediately.",
  },
];

export function buildSlashCommandHelpPresentation(
  channelType: string,
): SlashCommandHelpPresentation {
  const normalizedChannelType = channelType.trim().toLowerCase();
  const renderMode: SlashCommandHelpRenderMode =
    normalizedChannelType === "lark" ? "markdown" : "plain_text";
  const title = "Slash Commands";
  const summary = "Available slash commands and suggested usage";
  const markdownSections = [
    buildCommandsMarkdownSection(),
    buildSuggestedUsageMarkdownSection(),
    buildRenderingMarkdownSection(channelType, renderMode),
  ];

  return {
    title,
    summary,
    renderMode,
    markdownSections,
    plainText: buildPlainTextHelp(channelType, renderMode),
  };
}

function buildCommandsMarkdownSection(): string {
  const lines = SLASH_COMMANDS.map((entry) => `- **${entry.command}** — ${entry.description}`);
  return ["### Slash Commands", ...lines].join("\n");
}

function buildSuggestedUsageMarkdownSection(): string {
  const lines = SLASH_COMMANDS.map((entry) => `- **${entry.command}** — ${entry.suggestedUse}`);
  return ["### Suggested Usage", ...lines].join("\n");
}

function buildRenderingMarkdownSection(
  channelType: string,
  renderMode: SlashCommandHelpRenderMode,
): string {
  const channelLabel = formatChannelLabel(channelType);
  return [
    "### Rendering",
    `- Channel: **${channelLabel}**`,
    `- Mode: **${renderMode === "markdown" ? "Markdown" : "Plain text"}**`,
  ].join("\n");
}

function buildPlainTextHelp(channelType: string, renderMode: SlashCommandHelpRenderMode): string {
  const lines = [
    "Slash Commands",
    ...SLASH_COMMANDS.map((entry) => `${entry.command} — ${entry.description}`),
    "",
    "Suggested Usage",
    ...SLASH_COMMANDS.map((entry) => `${entry.command} — ${entry.suggestedUse}`),
    "",
    `Rendering: ${formatChannelLabel(channelType)} / ${renderMode === "markdown" ? "Markdown" : "Plain text"}`,
  ];
  return lines.join("\n");
}

function formatChannelLabel(channelType: string): string {
  const trimmed = channelType.trim();
  if (trimmed.length === 0) {
    return "Unknown";
  }
  return trimmed.slice(0, 1).toUpperCase() + trimmed.slice(1);
}
