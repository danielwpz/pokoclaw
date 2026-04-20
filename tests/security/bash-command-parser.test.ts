import { describe, expect, test } from "vitest";

import { parseConservativeBashCommandSequence } from "@/src/security/bash-prefix.js";

describe("parseConservativeBashCommandSequence", () => {
  test("parses a simple command with env assignments and quoted literals", () => {
    expect(
      parseConservativeBashCommandSequence(
        'FOO=1 BAR=two python -m agent_browser_cli --url "https://example.com"',
      ),
    ).toEqual({
      kind: "simple",
      commands: [
        {
          envAssignments: ["FOO=1", "BAR=two"],
          argv: ["python", "-m", "agent_browser_cli", "--url", "https://example.com"],
        },
      ],
    });
  });

  test("parses single-quoted raw string arguments", () => {
    expect(
      parseConservativeBashCommandSequence(
        "python -m agent_browser_cli --url 'https://example.com'",
      ),
    ).toEqual({
      kind: "simple",
      commands: [
        {
          envAssignments: [],
          argv: ["python", "-m", "agent_browser_cli", "--url", "https://example.com"],
        },
      ],
    });
  });

  test("parses compound commands and preserves each subcommand argv", () => {
    expect(parseConservativeBashCommandSequence("npm test && echo done | cat")).toEqual({
      kind: "compound",
      commands: [
        {
          envAssignments: [],
          argv: ["npm", "test"],
        },
        {
          envAssignments: [],
          argv: ["echo", "done"],
        },
        {
          envAssignments: [],
          argv: ["cat"],
        },
      ],
    });
  });

  test("accepts supported output redirections without changing argv extraction", () => {
    expect(
      parseConservativeBashCommandSequence(
        "agent-browser snapshot -s main > /tmp/browser.txt 2>&1",
      ),
    ).toEqual({
      kind: "simple",
      commands: [
        {
          envAssignments: [],
          argv: ["agent-browser", "snapshot", "-s", "main"],
          hasOutputRedirect: true,
        },
      ],
    });
  });

  test("rejects unsupported shell expansions", () => {
    expect(parseConservativeBashCommandSequence("FOO=$BAR npm test")).toBeNull();
    expect(parseConservativeBashCommandSequence("npm run $(cat cmd.txt)")).toBeNull();
    expect(parseConservativeBashCommandSequence('echo "$' + "{HOME}" + '"')).toBeNull();
  });

  test("rejects unsupported input-side redirections", () => {
    expect(parseConservativeBashCommandSequence("cat < input.txt")).toBeNull();
    expect(parseConservativeBashCommandSequence("cat <<EOF\nhello\nEOF")).toBeNull();
  });
});
