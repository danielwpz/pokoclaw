import { describe, expect, test } from "vitest";

import { LarkClientRegistry } from "@/src/channels/lark/client.js";

describe("LarkClientRegistry", () => {
  test("creates and caches clients per installation", () => {
    const registry = new LarkClientRegistry([
      {
        installationId: "default",
        appId: "cli_123",
        appSecret: "secret_123",
        config: {
          enabled: true,
          appId: "cli_123",
          appSecret: "secret_123",
          connectionMode: "websocket",
        },
      },
    ]);

    const first = registry.getOrCreate("default");
    const second = registry.getOrCreate("default");

    expect(first).toBe(second);
    expect(registry.activeClientCount()).toBe(1);
  });

  test("throws for unknown installations", () => {
    const registry = new LarkClientRegistry([]);
    expect(() => registry.getOrCreate("missing")).toThrow("Unknown Lark installation: missing");
  });
});
