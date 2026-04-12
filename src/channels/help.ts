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
}

const SLASH_COMMANDS: SlashCommandHelpEntry[] = [
  {
    command: "/help",
    description: "Show this help message.",
  },
  {
    command: "/status",
    description: "Show the current conversation status, model, usage, and active runs.",
  },
  {
    command: "/model",
    description: "Open the model switch card for the current conversation.",
  },
  {
    command: "/stop",
    description: "Stop the current conversation or session.",
  },
];

export function buildSlashCommandHelpPresentation(
  channelType: string,
): SlashCommandHelpPresentation {
  const normalizedChannelType = channelType.trim().toLowerCase();
  const renderMode: SlashCommandHelpRenderMode =
    normalizedChannelType === "lark" ? "markdown" : "plain_text";
  const title = "Slash Commands";
  const summary = "Slash commands";
  const markdownSections = [buildCommandsMarkdownSection()];

  return {
    title,
    summary,
    renderMode,
    markdownSections,
    plainText: buildPlainTextHelp(channelType),
  };
}

function buildCommandsMarkdownSection(): string {
  const lines = SLASH_COMMANDS.map((entry) => `- ${entry.command} — ${entry.description}`);
  return ["### Slash Commands", ...lines].join("\n");
}

function buildPlainTextHelp(channelType: string): string {
  const lines = [
    "Slash Commands",
    ...SLASH_COMMANDS.map((entry) => `${entry.command} — ${entry.description}`),
    "",
    `Channel: ${formatChannelLabel(channelType)}`,
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
