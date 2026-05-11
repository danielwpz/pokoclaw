import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool as SdkMcpTool,
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_CONFIG } from "@/src/config/defaults.js";
import type {
  McpConfig,
  McpStdioServerConfig,
  McpStreamableHttpServerConfig,
  McpToolPolicy,
} from "@/src/config/schema.js";
import { McpCatalogService } from "@/src/mcp/catalog.js";
import { McpClientManager } from "@/src/mcp/manager.js";
import { McpToolSource } from "@/src/mcp/tool-source.js";
import type { McpConnectedServer } from "@/src/mcp/types.js";
import { SecurityService } from "@/src/security/service.js";
import { CompositeToolRegistry } from "@/src/tools/core/composite-registry.js";
import { isToolApprovalRequired, type ToolFailure } from "@/src/tools/core/errors.js";
import {
  createTestDatabase,
  destroyTestDatabase,
  type TestDatabaseHandle,
} from "@/tests/storage/helpers/test-db.js";

describe("McpToolSource", () => {
  let handle: TestDatabaseHandle | null = null;

  afterEach(async () => {
    if (handle != null) {
      await destroyTestDatabase(handle);
      handle = null;
    }
  });

  test("lists catalog tools and executes through the unified registry", async () => {
    handle = await createTestDatabase(import.meta.url);
    const { registry, callTool, manager } = await createHarness({
      handle,
      policy: "always_allow",
      tools: [
        makeSdkTool({
          name: "read",
          description: "Read from MCP",
          inputSchema: {
            type: "object",
            properties: {
              id: { type: "string" },
            },
            required: ["id"],
            additionalProperties: false,
          },
        }),
      ],
    });

    const result = await registry.execute("mcp__linear__read", makeContext(handle), {
      id: "ISSUE-1",
    });

    expect(callTool).toHaveBeenCalledWith(
      {
        name: "read",
        arguments: {
          id: "ISSUE-1",
        },
      },
      undefined,
      expect.objectContaining({
        timeout: 120_000,
      }),
    );
    expect(result).toMatchObject({
      content: [{ type: "text", text: "remote ok" }],
      details: {
        mcp: {
          serverName: "linear",
          remoteName: "read",
          modelName: "mcp__linear__read",
        },
      },
    });
    expect(manager.recordServerOperationSucceeded).toHaveBeenCalledWith("linear");
  });

  test("discovers and executes against a real MCP server over the SDK transport", async () => {
    handle = await createTestDatabase(import.meta.url);
    const server = new Server(
      {
        name: "real-mcp-server",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      },
    );
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: [
        {
          name: "echo",
          description: "Echo text through MCP",
          inputSchema: {
            type: "object",
            properties: {
              text: { type: "string" },
            },
            required: ["text"],
            additionalProperties: false,
          },
        },
      ],
    }));
    server.setRequestHandler(CallToolRequestSchema, (request) => {
      const text = (request.params.arguments as { text?: unknown } | undefined)?.text;
      return {
        content: [
          {
            type: "text",
            text: `echo:${text}`,
          },
        ],
      };
    });
    const manager = new McpClientManager({
      config: makeConfig({
        linear: makeServerConfig({ toolPolicy: "always_allow" }),
      }),
      transportFactory: {
        createTransport: () => {
          const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
          void server.connect(serverTransport);
          return clientTransport as unknown as Transport;
        },
      },
    });
    const catalog = new McpCatalogService({
      manager,
      now: () => 1_000,
    });
    const registry = new CompositeToolRegistry([new McpToolSource({ manager, catalog })]);

    try {
      await manager.start();
      await catalog.refreshAll();

      expect(registry.list().map((tool) => tool.name)).toEqual(["mcp__linear__echo"]);
      const result = await registry.execute("mcp__linear__echo", makeContext(handle), {
        text: "hello",
      });

      expect(result.content).toEqual([
        {
          type: "text",
          text: "echo:hello",
        },
      ]);
    } finally {
      await manager.shutdown();
      await server.close();
    }
  });

  test("validates MCP JSON Schema before remote execution", async () => {
    handle = await createTestDatabase(import.meta.url);
    const { registry, callTool } = await createHarness({
      handle,
      policy: "always_allow",
      tools: [
        makeSdkTool({
          name: "read",
          inputSchema: {
            type: "object",
            properties: {
              id: { type: "string" },
            },
            required: ["id"],
            additionalProperties: false,
          },
        }),
      ],
    });

    await expect(
      registry.execute("mcp__linear__read", makeContext(handle), {
        id: 123,
        extra: true,
      }),
    ).rejects.toMatchObject({
      name: "ToolFailure",
      kind: "recoverable_error",
      details: {
        code: "invalid_tool_args",
        toolName: "mcp__linear__read",
      },
    } satisfies Partial<ToolFailure>);
    expect(callTool).not.toHaveBeenCalled();
  });

  test("requires unified approval for ask policy when no active grant exists", async () => {
    handle = await createTestDatabase(import.meta.url);
    const { registry } = await createHarness({
      handle,
      policy: "ask",
      tools: [makeSdkTool({ name: "create_issue" })],
    });

    await expect(
      registry.execute("mcp__linear__create_issue", makeContext(handle), {}),
    ).rejects.toSatisfy((error: unknown) => {
      expect(isToolApprovalRequired(error)).toBe(true);
      if (!isToolApprovalRequired(error)) {
        return false;
      }
      expect(error.request.scopes).toEqual([
        {
          kind: "mcp.tool",
          server: "linear",
          tool: "create_issue",
          serverFingerprint: "server-fingerprint",
          catalogVersion: expect.any(String),
        },
      ]);
      expect(error.approvalTitle).toBe("Approval required: MCP · Linear · Create issue");
      expect(error.approvalCommand).toBeUndefined();
      return true;
    });
  });

  test("uses active MCP grants before server-level ask policy", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedAgentFixture(handle);
    const { registry, catalog, callTool } = await createHarness({
      handle,
      policy: "ask",
      tools: [makeSdkTool({ name: "create_issue" })],
    });
    const tool = catalog.findCachedToolByName("mcp__linear__create_issue");
    if (tool == null) {
      throw new Error("Expected cached MCP tool");
    }
    new SecurityService(handle.storage.db).grantScopes({
      ownerAgentId: "agent_1",
      scopes: [
        {
          kind: "mcp.tool",
          server: "linear",
          tool: "create_issue",
          serverFingerprint: tool.serverFingerprint,
          catalogVersion: tool.catalogVersion,
        },
      ],
      grantedBy: "user",
      createdAt: new Date("2026-05-11T00:00:00.000Z"),
      expiresAt: new Date("2026-05-18T00:00:00.000Z"),
    });

    await registry.execute("mcp__linear__create_issue", makeContext(handle, "agent_1"), {});

    expect(callTool).toHaveBeenCalledOnce();
  });

  test("auto policy allows read-only tools and still asks for risky tools", async () => {
    handle = await createTestDatabase(import.meta.url);
    const { registry, callTool } = await createHarness({
      handle,
      policy: "auto",
      tools: [
        makeSdkTool({
          name: "search",
          annotations: { readOnlyHint: true },
        }),
        makeSdkTool({
          name: "delete",
          annotations: { readOnlyHint: true, destructiveHint: true },
        }),
      ],
    });

    await registry.execute("mcp__linear__search", makeContext(handle), {});
    await expect(
      registry.execute("mcp__linear__delete", makeContext(handle), {}),
    ).rejects.toSatisfy((error: unknown) => isToolApprovalRequired(error));

    expect(callTool).toHaveBeenCalledTimes(1);
  });

  test("reconnects streamable HTTP servers and retries once on expired session 404", async () => {
    handle = await createTestDatabase(import.meta.url);
    const { registry, callTool, manager } = await createHarness({
      handle,
      policy: "always_allow",
      serverConfig: makeStreamableServerConfig({
        toolPolicy: "always_allow",
      }),
      callTool: vi
        .fn()
        .mockRejectedValueOnce(new StreamableHTTPError(404, "session expired"))
        .mockResolvedValueOnce({
          content: [
            {
              type: "text" as const,
              text: "after reconnect",
            },
          ],
        }),
      tools: [makeSdkTool({ name: "search" })],
    });

    const result = await registry.execute("mcp__linear__search", makeContext(handle), {});

    expect(result.content).toEqual([
      {
        type: "text",
        text: "after reconnect",
      },
    ]);
    expect(callTool).toHaveBeenCalledTimes(2);
    expect(manager.reconnectServer).toHaveBeenCalledWith(
      "linear",
      "streamable_http_session_expired",
    );
    expect(manager.recordServerOperationSucceeded).toHaveBeenCalledWith("linear");
    expect(manager.recordServerOperationFailed).not.toHaveBeenCalled();
  });
});

async function createHarness(input: {
  handle: TestDatabaseHandle;
  policy: McpToolPolicy;
  tools: SdkMcpTool[];
  serverConfig?: McpConnectedServer["config"];
  callTool?: ReturnType<typeof vi.fn>;
}) {
  const listTools = vi.fn(async () => ({ tools: input.tools }));
  const callTool =
    input.callTool ??
    vi.fn(async () => ({
      content: [
        {
          type: "text" as const,
          text: "remote ok",
        },
      ],
    }));
  const serverConfig = input.serverConfig ?? makeServerConfig({ toolPolicy: input.policy });
  const connected: McpConnectedServer = {
    name: "linear",
    config: serverConfig,
    configFingerprint: "server-fingerprint",
    client: { listTools, callTool } as unknown as Client,
    transport: {} as Transport,
  };
  const manager = {
    getConnectedServer: (name: string) => (name === "linear" ? connected : null),
    getConnectedServers: () => [connected],
    recordCatalogRefreshStarted: vi.fn(),
    recordCatalogRefreshSucceeded: vi.fn(),
    recordCatalogRefreshFailed: vi.fn(),
    recordServerOperationSucceeded: vi.fn(),
    recordServerOperationFailed: vi.fn(),
    reconnectServer: vi.fn(async () => connected),
  } as unknown as McpClientManager & {
    recordServerOperationSucceeded: ReturnType<typeof vi.fn>;
    recordServerOperationFailed: ReturnType<typeof vi.fn>;
    reconnectServer: ReturnType<typeof vi.fn>;
  };
  const catalog = new McpCatalogService({
    manager,
    now: () => 1_000,
  });
  await catalog.refreshAll();
  const source = new McpToolSource({ manager, catalog });
  const registry = new CompositeToolRegistry([source]);

  return {
    registry,
    catalog,
    manager,
    callTool,
  };
}

function makeContext(handle: TestDatabaseHandle, ownerAgentId = "agent_missing") {
  return {
    sessionId: "sess_1",
    conversationId: "conv_1",
    ownerAgentId,
    securityConfig: DEFAULT_CONFIG.security,
    storage: handle.storage.db,
  };
}

function makeSdkTool(input: Partial<SdkMcpTool> & { name: string }): SdkMcpTool {
  return {
    name: input.name,
    description: input.description ?? `Tool ${input.name}`,
    inputSchema: input.inputSchema ?? {
      type: "object",
      properties: {},
    },
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

function makeConfig(servers: Record<string, McpStdioServerConfig>): McpConfig {
  return {
    enabled: true,
    catalogTtlMs: 86_400_000,
    startupTimeoutMs: 30_000,
    toolTimeoutMs: 120_000,
    failureWindowMs: 300_000,
    degradeAfterConsecutiveFailures: 3,
    failStartupOnRequired: false,
    servers,
  };
}

function seedAgentFixture(handle: TestDatabaseHandle): void {
  handle.storage.sqlite.exec(`
    INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
    VALUES ('ci_1', 'lark', 'acct_a', '2026-03-22T00:00:00.000Z', '2026-03-22T00:00:00.000Z');
    INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
    VALUES ('conv_1', 'ci_1', 'chat_1', 'dm', '2026-03-22T00:00:00.000Z', '2026-03-22T00:00:00.000Z');
    INSERT INTO agents (id, conversation_id, kind, created_at)
    VALUES ('agent_1', 'conv_1', 'main', '2026-03-22T00:00:00.000Z');
  `);
}
