import { describe, expect, test } from "vitest";

import {
  bashPrefixMatchesCommand,
  normalizeBashCommandPrefix,
  parseSimpleBashCommand,
} from "@/src/security/bash-prefix.js";

describe("bash prefix normalization", () => {
  test("normalizes a simple command argv", () => {
    expect(normalizeBashCommandPrefix("npm run dev")).toEqual(["npm", "run", "dev"]);
  });

  test("strips leading environment assignments before matching", () => {
    expect(parseSimpleBashCommand("FOO=1 BAR=2 npm run dev")).toEqual({
      envAssignments: ["FOO=1", "BAR=2"],
      argv: ["npm", "run", "dev"],
    });
  });

  test("supports quoted literal arguments", () => {
    expect(
      normalizeBashCommandPrefix("python -m agent_browser_cli --url 'https://example.com'"),
    ).toEqual(["python", "-m", "agent_browser_cli", "--url", "https://example.com"]);
  });

  test("rejects compound shell commands", () => {
    expect(normalizeBashCommandPrefix("cd foo && npm run dev")).toBeNull();
    expect(normalizeBashCommandPrefix("npm run dev | tee out.log")).toBeNull();
  });

  test("rejects shell expansions and substitutions", () => {
    expect(normalizeBashCommandPrefix("FOO=$BAR npm run dev")).toBeNull();
    expect(normalizeBashCommandPrefix("npm run $(cat cmd.txt)")).toBeNull();
  });

  test("matches a granted prefix against a normalized argv", () => {
    expect(bashPrefixMatchesCommand(["npm", "run"], ["npm", "run", "dev"])).toBe(true);
    expect(bashPrefixMatchesCommand(["npm", "test"], ["npm", "run", "dev"])).toBe(false);
  });
});
