import { describe, expect, test } from "vitest";
import { patchScenarioModelListInToml } from "@/src/config/model-scenario-patch.js";

describe("patchScenarioModelListInToml", () => {
  test("replaces an existing single-line scenario array without rewriting other config", () => {
    const original = [
      "# keep me",
      "[logging]",
      'level = "info"',
      "useColors = false",
      "",
      "[models.scenarios]",
      'chat = ["deepseek"] # current chat model',
      'task = ["deepseek"]',
      "",
      "[runtime]",
      "maxTurns = 60",
      "",
    ].join("\n");

    const patched = patchScenarioModelListInToml({
      tomlText: original,
      scenario: "chat",
      modelIds: ["gpt5", "deepseek"],
    });

    expect(patched).toContain("# keep me");
    expect(patched).toContain('chat = ["gpt5", "deepseek"] # current chat model');
    expect(patched).toContain('task = ["deepseek"]');
    expect(patched).toContain("[runtime]");
  });

  test("replaces an existing multiline scenario array", () => {
    const original = [
      "[models.scenarios]",
      "chat = [",
      '  "deepseek",',
      '  "gpt5",',
      "]",
      'task = ["deepseek"]',
      "",
    ].join("\n");

    const patched = patchScenarioModelListInToml({
      tomlText: original,
      scenario: "chat",
      modelIds: ["minimax", "gpt5", "deepseek"],
    });

    expect(patched).toContain('  "minimax",');
    expect(patched).toContain('  "gpt5",');
    expect(patched).toContain('  "deepseek",');
    expect(patched).toContain('task = ["deepseek"]');
  });

  test("inserts a new scenario key into an existing models.scenarios section", () => {
    const original = [
      "[models.scenarios]",
      'chat = ["deepseek"]',
      "",
      "[runtime]",
      "maxTurns = 60",
      "",
    ].join("\n");

    const patched = patchScenarioModelListInToml({
      tomlText: original,
      scenario: "task",
      modelIds: ["gpt5"],
    });

    expect(patched).toContain('chat = ["deepseek"]');
    expect(patched).toContain('task = ["gpt5"]');
    expect(patched.indexOf("[runtime]")).toBeGreaterThan(patched.indexOf('task = ["gpt5"]'));
  });

  test("appends a models.scenarios section when the file does not define one", () => {
    const original = ["[logging]", 'level = "info"', "useColors = false", ""].join("\n");

    const patched = patchScenarioModelListInToml({
      tomlText: original,
      scenario: "chat",
      modelIds: ["gpt5"],
    });

    expect(patched).toContain("[models.scenarios]");
    expect(patched).toContain('chat = ["gpt5"]');
  });
});
