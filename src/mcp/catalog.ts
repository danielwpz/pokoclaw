import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Tool as SdkMcpTool } from "@modelcontextprotocol/sdk/types.js";
import { computeStableFingerprint } from "@/src/mcp/fingerprint.js";
import type { McpClientManager } from "@/src/mcp/manager.js";
import { buildMcpModelToolName } from "@/src/mcp/names.js";
import { createSubsystemLogger } from "@/src/shared/logger.js";
import type { JsonSchemaObject } from "@/src/tools/core/schema.js";

const logger = createSubsystemLogger("mcp-catalog");
const EMPTY_OBJECT_SCHEMA: JsonSchemaObject = {
  type: "object",
  properties: {},
};

export type McpCatalogCacheState = "fresh" | "stale" | "refreshing" | "failed";

export interface McpCatalogTool {
  name: string;
  serverName: string;
  serverFingerprint: string;
  catalogVersion: string;
  remoteName: string;
  description: string;
  title?: string;
  inputSchema: JsonSchemaObject;
  outputSchema?: JsonSchemaObject;
  annotations?: SdkMcpTool["annotations"];
}

export interface McpServerCatalogSnapshot {
  serverName: string;
  serverFingerprint: string;
  catalogVersion: string;
  cacheState: McpCatalogCacheState;
  tools: McpCatalogTool[];
  fetchedAtMs: number;
  expiresAtMs: number;
  lastError: string | null;
}

export interface McpCatalogSnapshot {
  generatedAtMs: number;
  servers: McpServerCatalogSnapshot[];
}

export interface McpCatalogServiceOptions {
  manager: McpClientManager;
  now?: () => number;
}

interface CatalogCacheEntry {
  snapshot: McpServerCatalogSnapshot;
  refreshPromise: Promise<McpServerCatalogSnapshot | null> | null;
}

export class McpCatalogService {
  private readonly manager: McpClientManager;
  private readonly now: () => number;
  private readonly cache = new Map<string, CatalogCacheEntry>();

  constructor(options: McpCatalogServiceOptions) {
    this.manager = options.manager;
    this.now = options.now ?? Date.now;
  }

  listCachedTools(): McpCatalogTool[] {
    this.refreshExpiredConnectedServers();
    const connectedFingerprints = new Map(
      this.manager.getConnectedServers().map((server) => [server.name, server.configFingerprint]),
    );
    const tools: McpCatalogTool[] = [];
    for (const [serverName, entry] of this.cache) {
      if (connectedFingerprints.get(serverName) !== entry.snapshot.serverFingerprint) {
        continue;
      }
      tools.push(...entry.snapshot.tools);
    }

    return tools.sort((a, b) => a.name.localeCompare(b.name));
  }

  findCachedToolByName(name: string): McpCatalogTool | null {
    return this.listCachedTools().find((tool) => tool.name === name) ?? null;
  }

  getSnapshot(): McpCatalogSnapshot {
    const now = this.now();
    return {
      generatedAtMs: now,
      servers: [...this.cache.values()]
        .map((entry) => this.renderSnapshot(entry, now))
        .sort((a, b) => a.serverName.localeCompare(b.serverName)),
    };
  }

  async getServerCatalog(serverName: string): Promise<McpServerCatalogSnapshot | null> {
    const connected = this.manager.getConnectedServer(serverName);
    const entry = this.cache.get(serverName);
    const now = this.now();
    if (connected == null) {
      return null;
    }

    if (entry != null && entry.snapshot.serverFingerprint === connected.configFingerprint) {
      if (entry.snapshot.expiresAtMs > now) {
        return this.renderSnapshot(entry, now);
      }
      this.refreshServerInBackground(serverName);
      return this.renderSnapshot(entry, now);
    }

    return await this.refreshServer(serverName);
  }

  async refreshAll(): Promise<void> {
    await Promise.all(
      this.manager.getConnectedServers().map((server) => this.refreshServer(server.name)),
    );
  }

  async refreshServer(serverName: string): Promise<McpServerCatalogSnapshot | null> {
    const existing = this.cache.get(serverName);
    if (existing?.refreshPromise != null) {
      return await existing.refreshPromise;
    }

    const connected = this.manager.getConnectedServer(serverName);
    if (connected == null) {
      this.cache.delete(serverName);
      return null;
    }

    const entry =
      existing ??
      ({
        snapshot: createEmptyCatalogSnapshot({
          serverName,
          serverFingerprint: connected.configFingerprint,
          now: this.now(),
        }),
        refreshPromise: null,
      } satisfies CatalogCacheEntry);
    this.cache.set(serverName, entry);

    const refreshPromise = this.fetchServerCatalog(serverName)
      .then((snapshot) => {
        entry.snapshot = snapshot;
        this.manager.recordCatalogRefreshSucceeded({
          serverName,
          catalogVersion: snapshot.catalogVersion,
          fetchedAtMs: snapshot.fetchedAtMs,
          expiresAtMs: snapshot.expiresAtMs,
        });
        return snapshot;
      })
      .catch((error: unknown) => {
        this.manager.recordCatalogRefreshFailed({ serverName, error });
        const lastError = error instanceof Error ? error.message : String(error);
        logger.warn("mcp catalog refresh failed", {
          serverName,
          error: lastError,
        });
        entry.snapshot = {
          ...entry.snapshot,
          cacheState: entry.snapshot.tools.length === 0 ? "failed" : "stale",
          lastError,
        };
        return entry.snapshot.tools.length === 0 ? null : entry.snapshot;
      })
      .finally(() => {
        entry.refreshPromise = null;
      });

    entry.refreshPromise = refreshPromise;
    return await refreshPromise;
  }

  async drainRefreshes(): Promise<void> {
    await Promise.all(
      [...this.cache.values()]
        .map((entry) => entry.refreshPromise)
        .filter((promise): promise is Promise<McpServerCatalogSnapshot | null> => promise != null),
    );
  }

  invalidateServer(serverName: string): void {
    this.cache.delete(serverName);
  }

  private refreshExpiredConnectedServers(): void {
    for (const connected of this.manager.getConnectedServers()) {
      const entry = this.cache.get(connected.name);
      if (
        entry == null ||
        entry.snapshot.serverFingerprint !== connected.configFingerprint ||
        entry.snapshot.expiresAtMs <= this.now()
      ) {
        this.refreshServerInBackground(connected.name);
      }
    }
  }

  private refreshServerInBackground(serverName: string): void {
    void this.refreshServer(serverName).catch((error: unknown) => {
      logger.warn("background mcp catalog refresh failed", {
        serverName,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private async fetchServerCatalog(serverName: string): Promise<McpServerCatalogSnapshot> {
    const connected = this.manager.getConnectedServer(serverName);
    if (connected == null) {
      throw new Error(`MCP server ${serverName} is not connected`);
    }

    this.manager.recordCatalogRefreshStarted(serverName);
    const listedTools = await listAllTools(connected.client, connected.config.toolTimeoutMs);
    const fetchedAtMs = this.now();
    const expiresAtMs = fetchedAtMs + connected.config.catalogTtlMs;
    const tools = materializeCatalogTools({
      serverName,
      serverFingerprint: connected.configFingerprint,
      listedTools,
    });
    const catalogVersion = computeStableFingerprint({
      serverName,
      serverFingerprint: connected.configFingerprint,
      tools: tools.map((tool) => ({
        remoteName: tool.remoteName,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        annotations: tool.annotations,
      })),
    });

    return {
      serverName,
      serverFingerprint: connected.configFingerprint,
      catalogVersion,
      cacheState: "fresh",
      tools: tools.map((tool) => ({
        ...tool,
        catalogVersion,
      })),
      fetchedAtMs,
      expiresAtMs,
      lastError: null,
    };
  }

  private renderSnapshot(entry: CatalogCacheEntry, now: number): McpServerCatalogSnapshot {
    if (entry.refreshPromise != null) {
      return {
        ...entry.snapshot,
        cacheState: "refreshing",
      };
    }

    if (entry.snapshot.cacheState === "failed") {
      return entry.snapshot;
    }

    return {
      ...entry.snapshot,
      cacheState: entry.snapshot.expiresAtMs > now ? "fresh" : "stale",
    };
  }
}

function materializeCatalogTools(input: {
  serverName: string;
  serverFingerprint: string;
  listedTools: SdkMcpTool[];
}): Array<Omit<McpCatalogTool, "catalogVersion"> & { catalogVersion?: string }> {
  const reservedNames = new Set<string>();
  return input.listedTools
    .filter((tool) => tool.name.trim().length > 0)
    .map((tool) => {
      const name = buildMcpModelToolName({
        serverName: input.serverName,
        remoteToolName: tool.name,
        reservedNames,
      });
      const description =
        tool.description?.trim() ??
        `MCP tool "${tool.name}" provided by server "${input.serverName}".`;
      const materialized: Omit<McpCatalogTool, "catalogVersion"> & {
        catalogVersion?: string;
      } = {
        name,
        serverName: input.serverName,
        serverFingerprint: input.serverFingerprint,
        remoteName: tool.name,
        description,
        inputSchema: normalizeInputSchema(tool.inputSchema),
      };
      if (tool.title != null) {
        materialized.title = tool.title;
      }
      if (tool.outputSchema != null) {
        materialized.outputSchema = normalizeInputSchema(tool.outputSchema);
      }
      if (tool.annotations != null) {
        materialized.annotations = tool.annotations;
      }
      return materialized;
    });
}

async function listAllTools(client: Client, timeoutMs: number): Promise<SdkMcpTool[]> {
  const tools: SdkMcpTool[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor == null ? undefined : { cursor }, {
      timeout: timeoutMs,
    });
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor != null);

  return tools;
}

function normalizeInputSchema(schema: unknown): JsonSchemaObject {
  if (!isPlainRecord(schema)) {
    return EMPTY_OBJECT_SCHEMA;
  }

  return {
    type: "object",
    ...schema,
  };
}

function createEmptyCatalogSnapshot(input: {
  serverName: string;
  serverFingerprint: string;
  now: number;
}): McpServerCatalogSnapshot {
  return {
    serverName: input.serverName,
    serverFingerprint: input.serverFingerprint,
    catalogVersion: "empty",
    cacheState: "failed",
    tools: [],
    fetchedAtMs: input.now,
    expiresAtMs: input.now,
    lastError: null,
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
