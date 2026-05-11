import { describe, expect, test } from "vitest";
import type { McpStreamableHttpServerConfig } from "@/src/config/schema.js";
import { buildStreamableHttpHeaders, DefaultMcpTransportFactory } from "@/src/mcp/transport.js";

describe("mcp transport factory", () => {
  test("builds streamable HTTP auth headers without exposing config shape to callers", () => {
    const config = makeStreamableHttpConfig({
      bearerToken: "pat_123",
      headers: {
        "X-Workspace": "workspace_1",
      },
    });

    expect(buildStreamableHttpHeaders(config)).toEqual({
      Authorization: "Bearer pat_123",
      "X-Workspace": "workspace_1",
    });
  });

  test("creates stdio transports without starting the process eagerly", () => {
    const factory = new DefaultMcpTransportFactory();
    const transport = factory.createTransport({
      serverName: "local",
      managerConfig: {
        enabled: true,
        catalogTtlMs: 86_400_000,
        startupTimeoutMs: 30_000,
        toolTimeoutMs: 120_000,
        failureWindowMs: 300_000,
        degradeAfterConsecutiveFailures: 3,
        failStartupOnRequired: false,
        servers: {},
      },
      config: {
        enabled: true,
        transport: "stdio",
        toolPolicy: "ask",
        startupTimeoutMs: 30_000,
        toolTimeoutMs: 120_000,
        catalogTtlMs: 86_400_000,
        failureWindowMs: 300_000,
        degradeAfterConsecutiveFailures: 3,
        failStartupOnRequired: false,
        command: "node",
        args: ["server.js"],
        env: {
          NODE_ENV: "test",
        },
      },
    });

    expect(typeof transport.start).toBe("function");
    expect(typeof transport.send).toBe("function");
    expect(typeof transport.close).toBe("function");
  });
});

function makeStreamableHttpConfig(
  overrides: Partial<McpStreamableHttpServerConfig> = {},
): McpStreamableHttpServerConfig {
  return {
    enabled: true,
    transport: "streamable_http",
    toolPolicy: "ask",
    startupTimeoutMs: 30_000,
    toolTimeoutMs: 120_000,
    catalogTtlMs: 86_400_000,
    failureWindowMs: 300_000,
    degradeAfterConsecutiveFailures: 3,
    failStartupOnRequired: false,
    url: "https://mcp.example.test/mcp",
    headers: {},
    ...overrides,
  };
}
