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
          redirects: [],
          stdinFromPipe: false,
          stdoutToPipe: false,
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
          redirects: [],
          stdinFromPipe: false,
          stdoutToPipe: false,
        },
      ],
    });
  });

  test("parses concatenated literal arguments such as gh field values", () => {
    expect(
      parseConservativeBashCommandSequence(
        "gh api repos/nearai/chat-api/pulls/271/comments/3216162798/replies --method POST -f body='Fixed. The user email is now loaded and email_verification_challenges rows are deleted by email before the users row is removed, all within the same transaction.'",
      ),
    ).toEqual({
      kind: "simple",
      commands: [
        {
          envAssignments: [],
          argv: [
            "gh",
            "api",
            "repos/nearai/chat-api/pulls/271/comments/3216162798/replies",
            "--method",
            "POST",
            "-f",
            "body=Fixed. The user email is now loaded and email_verification_challenges rows are deleted by email before the users row is removed, all within the same transaction.",
          ],
          redirects: [],
          stdinFromPipe: false,
          stdoutToPipe: false,
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
          redirects: [],
          stdinFromPipe: false,
          stdoutToPipe: false,
        },
        {
          envAssignments: [],
          argv: ["echo", "done"],
          redirects: [],
          stdinFromPipe: false,
          stdoutToPipe: true,
        },
        {
          envAssignments: [],
          argv: ["cat"],
          redirects: [],
          stdinFromPipe: true,
          stdoutToPipe: false,
        },
      ],
    });
  });

  test("accepts supported output redirections and preserves redirect metadata", () => {
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
          redirects: [
            { operator: ">", destination: "/tmp/browser.txt" },
            { operator: ">&", destination: "1" },
          ],
          stdinFromPipe: false,
          stdoutToPipe: false,
        },
      ],
    });
  });

  test("preserves pipe and redirection metadata for approval checks", () => {
    expect(parseConservativeBashCommandSequence("git pull | tail -n 5")).toEqual({
      kind: "compound",
      commands: [
        {
          envAssignments: [],
          argv: ["git", "pull"],
          redirects: [],
          stdinFromPipe: false,
          stdoutToPipe: true,
        },
        {
          envAssignments: [],
          argv: ["tail", "-n", "5"],
          redirects: [],
          stdinFromPipe: true,
          stdoutToPipe: false,
        },
      ],
    });

    expect(parseConservativeBashCommandSequence("echo '---' > /tmp/marker")).toEqual({
      kind: "simple",
      commands: [
        {
          envAssignments: [],
          argv: ["echo", "---"],
          redirects: [{ operator: ">", destination: "/tmp/marker" }],
          stdinFromPipe: false,
          stdoutToPipe: false,
        },
      ],
    });
  });

  test("conservatively attaches statement redirection to every command in a redirected list", () => {
    expect(
      parseConservativeBashCommandSequence(
        "git status && echo '---' > /tmp/marker && git diff --stat",
      ),
    ).toEqual({
      kind: "compound",
      commands: [
        {
          envAssignments: [],
          argv: ["git", "status"],
          redirects: [{ operator: ">", destination: "/tmp/marker" }],
          stdinFromPipe: false,
          stdoutToPipe: false,
        },
        {
          envAssignments: [],
          argv: ["echo", "---"],
          redirects: [{ operator: ">", destination: "/tmp/marker" }],
          stdinFromPipe: false,
          stdoutToPipe: false,
        },
        {
          envAssignments: [],
          argv: ["git", "diff", "--stat"],
          redirects: [],
          stdinFromPipe: false,
          stdoutToPipe: false,
        },
      ],
    });
  });

  test("rejects unsupported shell expansions", () => {
    expect(parseConservativeBashCommandSequence("FOO=$BAR npm test")).toBeNull();
    expect(parseConservativeBashCommandSequence("npm run $(cat cmd.txt)")).toBeNull();
    expect(
      parseConservativeBashCommandSequence("gh api repos/example -f body=$(cat body.txt)"),
    ).toBeNull();
    expect(parseConservativeBashCommandSequence('echo "$' + "{HOME}" + '"')).toBeNull();
  });

  test("rejects unsupported input-side redirections", () => {
    expect(parseConservativeBashCommandSequence("cat < input.txt")).toBeNull();
    expect(parseConservativeBashCommandSequence("cat <<EOF\nhello\nEOF")).toBeNull();
  });
});
