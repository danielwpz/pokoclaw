import { describe, expect, test } from "vitest";

import { createBuiltinToolRegistry } from "@/src/tools/builtins.js";

describe("builtin tools", () => {
  test("registers the current filesystem tool set", () => {
    const registry = createBuiltinToolRegistry();

    expect(registry.has("read")).toBe(true);
    expect(registry.has("write")).toBe(true);
    expect(registry.has("edit")).toBe(true);
    expect(registry.has("ls")).toBe(true);
    expect(registry.has("find")).toBe(true);
    expect(registry.has("grep")).toBe(true);
    expect(registry.list().map((tool) => tool.name)).toEqual([
      "read",
      "write",
      "edit",
      "ls",
      "find",
      "grep",
    ]);
  });
});
