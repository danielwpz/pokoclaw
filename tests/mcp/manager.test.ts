import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, describe, expect, test, vi } from "vitest";
import type {
  McpConfig,
  McpServerConfig,
  McpStdioServerConfig,
  McpStreamableHttpServerConfig,
} from "@/src/config/schema.js";
import { McpClientManager } from "@/src/mcp/manager.js";
import type { McpTransportFactory } from "@/src/mcp/types.js";

const openServers: McpServer[] = [];

afterEach(async () => {
  await Promise.all(openServers.map((server) => server.close()));
  openServers.length = 0;
});

describe("McpClientManager", () => {
  test("connects enabled servers and exposes a redacted status snapshot", async () => {
    const server = createTestServer();
    const manager = new McpClientManager({
      config: makeConfig({
        local: makeServerConfig(),
      }),
      transportFactory: createInMemoryFactory(server),
    });

    await manager.start();

    const snapshot = manager.getStatusSnapshot();
    expect(snapshot.enabled).toBe(true);
    expect(snapshot.generation).toBe(1);
    expect(snapshot.servers).toHaveLength(1);
    expect(snapshot.servers[0]).toMatchObject({
      name: "local",
      state: "ready",
      enabled: true,
      transport: "stdio",
      toolPolicy: "ask",
      lastError: null,
    });
    expect(snapshot.servers[0]?.configFingerprint).toHaveLength(64);
    expect(manager.getConnectedServer("local")).toMatchObject({
      name: "local",
    });

    await manager.shutdown();
    expect(manager.getConnectedServer("local")).toBeNull();
  });

  test("keeps configured servers disabled when global MCP is disabled", async () => {
    const factory: McpTransportFactory = {
      createTransport: vi.fn(() => {
        throw new Error("should not connect");
      }),
    };
    const manager = new McpClientManager({
      config: makeConfig(
        {
          local: makeServerConfig(),
        },
        { enabled: false },
      ),
      transportFactory: factory,
    });

    await manager.start();

    expect(factory.createTransport).not.toHaveBeenCalled();
    expect(manager.getStatusSnapshot().servers[0]).toMatchObject({
      name: "local",
      state: "disabled",
      enabled: false,
    });
  });

  test("marks a server failed when transport creation fails and redacts configured secrets", async () => {
    const manager = new McpClientManager({
      config: makeConfig({
        remote: makeStreamableServerConfig({
          bearerToken: "secret-token",
          headers: {
            "X-Workspace": "workspace-secret",
          },
        }),
      }),
      transportFactory: {
        createTransport: () => {
          throw new Error("auth failed: secret-token / workspace-secret");
        },
      },
    });

    await manager.start();

    expect(manager.getStatusSnapshot().servers[0]).toMatchObject({
      name: "remote",
      state: "failed",
      authStatus: "bearer_and_headers",
      lastError: "auth failed: [redacted] / [redacted]",
    });
  });

  test("times out slow server startup", async () => {
    const transport = new HangingTransport();
    const manager = new McpClientManager({
      config: makeConfig({
        slow: makeServerConfig({
          startupTimeoutMs: 5,
        }),
      }),
      transportFactory: {
        createTransport: () => transport as unknown as Transport,
      },
    });

    await manager.start();

    expect(manager.getStatusSnapshot().servers[0]).toMatchObject({
      name: "slow",
      state: "failed",
      lastError: "MCP server slow did not finish startup within 5ms",
    });
    expect(transport.closed).toBe(true);
  });

  test("reload replaces the active generation and closes old clients", async () => {
    const firstServer = createTestServer();
    const secondServer = createTestServer();
    let connectCount = 0;
    const manager = new McpClientManager({
      config: makeConfig({
        local: makeServerConfig(),
      }),
      transportFactory: {
        createTransport: () => {
          connectCount += 1;
          return createLinkedTransport(connectCount === 1 ? firstServer : secondServer);
        },
      },
    });

    await manager.start();
    const firstConnection = manager.getConnectedServer("local");

    await manager.reload(
      makeConfig({
        local: makeServerConfig({
          command: "node-next",
        }),
      }),
      "test_reload",
    );

    expect(connectCount).toBe(2);
    expect(manager.getStatusSnapshot()).toMatchObject({
      enabled: true,
      generation: 2,
    });
    expect(manager.getConnectedServer("local")).not.toBe(firstConnection);
    expect(manager.getStatusSnapshot().servers[0]).toMatchObject({
      state: "ready",
      lastError: null,
    });
  });

  test("reconnectServer replaces one connection and preserves catalog status", async () => {
    const firstServer = createTestServer();
    const secondServer = createTestServer();
    let connectCount = 0;
    const manager = new McpClientManager({
      config: makeConfig({
        local: makeServerConfig(),
      }),
      transportFactory: {
        createTransport: () => {
          connectCount += 1;
          return createLinkedTransport(connectCount === 1 ? firstServer : secondServer);
        },
      },
    });

    await manager.start();
    const firstConnection = manager.getConnectedServer("local");
    manager.recordCatalogRefreshSucceeded({
      serverName: "local",
      catalogVersion: "catalog-v1",
      fetchedAtMs: 1_000,
      expiresAtMs: 2_000,
    });

    const reconnected = await manager.reconnectServer("local", "test_session_expired");

    expect(connectCount).toBe(2);
    expect(reconnected).not.toBeNull();
    expect(reconnected).not.toBe(firstConnection);
    expect(manager.getStatusSnapshot().servers[0]).toMatchObject({
      state: "ready",
      catalogVersion: "catalog-v1",
      catalogFetchedAt: "1970-01-01T00:00:01.000Z",
      catalogExpiresAt: "1970-01-01T00:00:02.000Z",
      lastError: null,
    });
  });
});

function createTestServer(): McpServer {
  const server = new McpServer({
    name: "test-mcp-server",
    version: "1.0.0",
  });
  openServers.push(server);
  return server;
}

function createInMemoryFactory(server: McpServer): McpTransportFactory {
  return {
    createTransport: () => createLinkedTransport(server),
  };
}

function createLinkedTransport(server: McpServer): Transport {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  void server.connect(serverTransport);
  return clientTransport as unknown as Transport;
}

class HangingTransport {
  closed = false;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: Transport["onmessage"];

  start(): Promise<void> {
    return new Promise(() => {});
  }

  send(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closed = true;
    this.onclose?.();
    return Promise.resolve();
  }
}

function makeConfig(
  servers: Record<string, McpServerConfig>,
  overrides: Partial<Omit<McpConfig, "servers">> = {},
): McpConfig {
  return {
    enabled: true,
    catalogTtlMs: 86_400_000,
    startupTimeoutMs: 30_000,
    toolTimeoutMs: 120_000,
    failureWindowMs: 300_000,
    degradeAfterConsecutiveFailures: 3,
    failStartupOnRequired: false,
    servers,
    ...overrides,
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

function makeStreamableServerConfig(
  overrides: Partial<Omit<McpStreamableHttpServerConfig, "transport">> = {},
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
