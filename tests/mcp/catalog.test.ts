import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool as SdkMcpTool } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, test, vi } from "vitest";
import type { McpStdioServerConfig } from "@/src/config/schema.js";
import { McpCatalogService } from "@/src/mcp/catalog.js";
import type { McpClientManager } from "@/src/mcp/manager.js";
import type { McpConnectedServer } from "@/src/mcp/types.js";

describe("McpCatalogService", () => {
  test("discovers tools, normalizes model-visible names, and caches within ttl", async () => {
    let now = 1_000;
    const listTools = vi.fn(async (params?: { cursor?: string }) => {
      if (params?.cursor === "page_2") {
        return {
          tools: [
            makeSdkTool({
              name: "search.issue",
              description: "Search issues",
            }),
          ],
        };
      }

      return {
        tools: [
          makeSdkTool({
            name: "read",
            description: "Read a thing",
            title: "Read",
          }),
        ],
        nextCursor: "page_2",
      };
    });
    const manager = createManager({
      client: { listTools } as unknown as Client,
      serverConfig: makeServerConfig({ catalogTtlMs: 10_000 }),
    });
    const catalog = new McpCatalogService({
      manager,
      now: () => now,
    });

    const first = await catalog.getServerCatalog("linear");
    const second = await catalog.getServerCatalog("linear");

    expect(listTools).toHaveBeenCalledTimes(2);
    expect(first?.cacheState).toBe("fresh");
    expect(second?.cacheState).toBe("fresh");
    expect(first?.tools.map((tool) => tool.name)).toEqual([
      "mcp__linear__read",
      "mcp__linear__search_issue",
    ]);
    expect(first?.tools[0]).toMatchObject({
      serverName: "linear",
      remoteName: "read",
      description: "Read a thing",
      title: "Read",
      inputSchema: {
        type: "object",
      },
    });
    expect(first?.catalogVersion).toHaveLength(64);
    expect(manager.recordCatalogRefreshSucceeded).toHaveBeenCalledOnce();

    now += 1_000;
    await catalog.getServerCatalog("linear");
    expect(listTools).toHaveBeenCalledTimes(2);
  });

  test("returns stale catalog while an expired catalog refreshes", async () => {
    let now = 1_000;
    const refresh = {
      resolve: null as ((value: Awaited<ReturnType<Client["listTools"]>>) => void) | null,
    };
    const listTools = vi
      .fn()
      .mockResolvedValueOnce({
        tools: [makeSdkTool({ name: "old_tool", description: "Old" })],
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            refresh.resolve = resolve;
          }),
      );
    const manager = createManager({
      client: { listTools } as unknown as Client,
      serverConfig: makeServerConfig({ catalogTtlMs: 100 }),
    });
    const catalog = new McpCatalogService({
      manager,
      now: () => now,
    });

    await catalog.getServerCatalog("linear");
    now += 101;

    const stale = await catalog.getServerCatalog("linear");

    expect(stale?.cacheState).toBe("refreshing");
    expect(stale?.tools.map((tool) => tool.remoteName)).toEqual(["old_tool"]);
    expect(listTools).toHaveBeenCalledTimes(2);

    if (refresh.resolve == null) {
      throw new Error("Expected pending catalog refresh");
    }
    refresh.resolve({
      tools: [makeSdkTool({ name: "new_tool", description: "New" })],
    });
    await catalog.drainRefreshes();

    const fresh = await catalog.getServerCatalog("linear");
    expect(fresh?.cacheState).toBe("fresh");
    expect(fresh?.tools.map((tool) => tool.remoteName)).toEqual(["new_tool"]);
  });

  test("keeps stale tools when refresh fails and marks the manager degraded", async () => {
    let now = 1_000;
    const listTools = vi
      .fn()
      .mockResolvedValueOnce({
        tools: [makeSdkTool({ name: "read", description: "Read" })],
      })
      .mockRejectedValueOnce(new Error("catalog unavailable"));
    const manager = createManager({
      client: { listTools } as unknown as Client,
      serverConfig: makeServerConfig({ catalogTtlMs: 100 }),
    });
    const catalog = new McpCatalogService({
      manager,
      now: () => now,
    });

    await catalog.getServerCatalog("linear");
    now += 101;

    const stale = await catalog.refreshServer("linear");

    expect(stale?.cacheState).toBe("stale");
    expect(stale?.lastError).toBe("catalog unavailable");
    expect(stale?.tools.map((tool) => tool.remoteName)).toEqual(["read"]);
    expect(manager.recordCatalogRefreshFailed).toHaveBeenCalledWith({
      serverName: "linear",
      error: expect.any(Error),
    });
  });

  test("disambiguates colliding normalized tool names with a stable suffix", async () => {
    const listTools = vi.fn(async () => ({
      tools: [
        makeSdkTool({ name: "foo.bar", description: "Dot" }),
        makeSdkTool({ name: "foo@bar", description: "At" }),
      ],
    }));
    const manager = createManager({
      client: { listTools } as unknown as Client,
    });
    const catalog = new McpCatalogService({
      manager,
      now: () => 1_000,
    });

    const snapshot = await catalog.getServerCatalog("linear");

    expect(snapshot?.tools.map((tool) => tool.name)).toEqual([
      "mcp__linear__foo_bar",
      expect.stringMatching(/^mcp__linear__foo_bar_[a-f0-9]{8}$/),
    ]);
  });
});

function createManager(input: {
  client: Client;
  serverConfig?: McpStdioServerConfig;
}): McpClientManager & {
  recordCatalogRefreshSucceeded: ReturnType<typeof vi.fn>;
  recordCatalogRefreshFailed: ReturnType<typeof vi.fn>;
} {
  const serverConfig = input.serverConfig ?? makeServerConfig();
  const connected: McpConnectedServer = {
    name: "linear",
    config: serverConfig,
    configFingerprint: "server-fingerprint",
    client: input.client,
    transport: {} as Transport,
  };
  return {
    getConnectedServer: (name: string) => (name === "linear" ? connected : null),
    getConnectedServers: () => [connected],
    recordCatalogRefreshStarted: vi.fn(),
    recordCatalogRefreshSucceeded: vi.fn(),
    recordCatalogRefreshFailed: vi.fn(),
  } as unknown as McpClientManager & {
    recordCatalogRefreshSucceeded: ReturnType<typeof vi.fn>;
    recordCatalogRefreshFailed: ReturnType<typeof vi.fn>;
  };
}

function makeSdkTool(input: Partial<SdkMcpTool> & { name: string }): SdkMcpTool {
  return {
    name: input.name,
    description: input.description,
    title: input.title,
    inputSchema: input.inputSchema ?? {
      type: "object",
      properties: {},
    },
    ...(input.outputSchema == null ? {} : { outputSchema: input.outputSchema }),
    ...(input.annotations == null ? {} : { annotations: input.annotations }),
  };
}

function makeServerConfig(
  overrides: Partial<Omit<McpStdioServerConfig, "transport">> = {},
): McpStdioServerConfig {
  return {
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
    env: {},
    ...overrides,
  };
}
