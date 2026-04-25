import { describe, expect, test } from "vitest";

import { DEFAULT_CONFIG } from "@/src/config/defaults.js";
import { createBuiltinToolRegistry } from "@/src/tools/builtins.js";

describe("builtin tools", () => {
  test("registers the current filesystem tool set", () => {
    const registry = createBuiltinToolRegistry();

    expect(registry.has("bash")).toBe(true);
    expect(registry.has("read")).toBe(true);
    expect(registry.has("write")).toBe(true);
    expect(registry.has("edit")).toBe(true);
    expect(registry.has("ls")).toBe(true);
    expect(registry.has("list_dir")).toBe(true);
    expect(registry.has("grep")).toBe(true);
    expect(registry.has("query_system_db")).toBe(true);
    expect(registry.has("get_runtime_status")).toBe(true);
    expect(registry.has("get_think_tank_capabilities")).toBe(true);
    expect(registry.has("consult_think_tank")).toBe(true);
    expect(registry.has("get_think_tank_status")).toBe(true);
    expect(registry.has("consult_participant")).toBe(true);
    expect(registry.has("upsert_think_tank_step")).toBe(true);
    expect(registry.has("finish_think_tank_episode")).toBe(true);
    expect(registry.has("finish_task")).toBe(true);
    expect(registry.has("request_permissions")).toBe(true);
    expect(registry.has("review_permission_request")).toBe(true);
    expect(registry.has("create_subagent")).toBe(true);
    expect(registry.has("schedule_task")).toBe(true);
    expect(registry.has("background_task")).toBe(true);
    expect(registry.has("wait_task")).toBe(true);
    expect(registry.has("list_background_tasks")).toBe(true);
    expect(registry.has("web_search")).toBe(false);
    expect(registry.has("web_fetch")).toBe(false);
    expect(registry.list().map((tool) => tool.name)).toEqual([
      "bash",
      "read",
      "write",
      "edit",
      "ls",
      "list_dir",
      "grep",
      "query_system_db",
      "get_runtime_status",
      "get_think_tank_capabilities",
      "consult_think_tank",
      "get_think_tank_status",
      "consult_participant",
      "upsert_think_tank_step",
      "finish_think_tank_episode",
      "finish_task",
      "request_permissions",
      "review_permission_request",
      "create_subagent",
      "schedule_task",
      "background_task",
      "wait_task",
      "list_background_tasks",
    ]);
  });

  test("registers configured web tools", () => {
    const registry = createBuiltinToolRegistry({
      providers: {
        tavily: {
          api: "tavily",
          apiKey: "tvly-test",
        },
      },
      tools: {
        ...DEFAULT_CONFIG.tools,
        web: {
          search: {
            enabled: true,
            provider: "tavily",
          },
          fetch: {
            enabled: true,
            provider: "tavily",
          },
        },
      },
    });

    expect(registry.has("web_search")).toBe(true);
    expect(registry.has("web_fetch")).toBe(true);
  });
});
