import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, test } from "vitest";
import type { McpStreamableHttpServerConfig } from "@/src/config/schema.js";
import {
  buildStreamableHttpHeaders,
  createMcpTransport,
  DefaultMcpTransportFactory,
} from "@/src/mcp/transport.js";

const openServers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

describe("mcp transport factory", () => {
  test.each([
    false,
    true,
  ])("only forwards custom credentials through same-origin redirects (cross-origin: %s)", async (crossOrigin) => {
    const receivedKeys: Array<string | string[] | undefined> = [];
    const destination = createServer((request, response) => {
      receivedKeys.push(request.headers["x-api-key"]);
      request.resume();
      response.writeHead(202).end();
    });
    const destinationUrl = await listen(destination);
    let sourceUrl = "";
    const source = createServer((request, response) => {
      request.resume();
      if (request.url === "/redirect") {
        response.writeHead(307, { Location: crossOrigin ? destinationUrl : `${sourceUrl}/mcp` });
      } else {
        receivedKeys.push(request.headers["x-api-key"]);
        response.writeHead(202);
      }
      response.end();
    });
    sourceUrl = await listen(source);
    const transport = createMcpTransport(
      makeStreamableHttpConfig({
        url: `${sourceUrl}/redirect`,
        headers: { "X-API-Key": "test-mcp-key" },
      }),
    );

    try {
      await transport.start();
      const sent = transport.send({ jsonrpc: "2.0", id: 1, method: "ping" });
      if (crossOrigin) {
        await expect(sent).rejects.toThrow("same-origin");
        expect(receivedKeys).toEqual([]);
      } else {
        await sent;
        expect(receivedKeys).toEqual(["test-mcp-key"]);
      }
    } finally {
      await transport.close();
    }
  });

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

async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  openServers.push(server);
  const address = server.address();
  if (address == null || typeof address === "string") {
    throw new Error("Expected a TCP server address");
  }
  return `http://127.0.0.1:${address.port}`;
}

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
