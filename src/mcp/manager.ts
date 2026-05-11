import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpConfig, McpServerConfig } from "@/src/config/schema.js";
import { computeStableFingerprint } from "@/src/mcp/fingerprint.js";
import { DefaultMcpTransportFactory } from "@/src/mcp/transport.js";
import type {
  McpAuthStatus,
  McpConnectedServer,
  McpManagerStatusSnapshot,
  McpServerLifecycleState,
  McpTransportFactory,
} from "@/src/mcp/types.js";
import { createSubsystemLogger } from "@/src/shared/logger.js";

const logger = createSubsystemLogger("mcp-manager");
const CLIENT_NAME = "pokoclaw";
const CLIENT_VERSION = "0.1.0";

export interface McpClientManagerOptions {
  config: McpConfig;
  transportFactory?: McpTransportFactory;
}

interface MutableMcpServerStatus {
  name: string;
  state: McpServerLifecycleState;
  enabled: boolean;
  transport: McpServerConfig["transport"];
  toolPolicy: McpServerConfig["toolPolicy"];
  configFingerprint: string;
  authStatus: McpAuthStatus;
  startedAt: string | null;
  readyAt: string | null;
  catalogVersion: string | null;
  catalogFetchedAt: string | null;
  catalogExpiresAt: string | null;
  updatedAt: string;
  lastError: string | null;
}

interface ServerRuntime {
  status: MutableMcpServerStatus;
  connected: McpConnectedServer | null;
  startPromise: Promise<void> | null;
  generation: number;
  consecutiveFailures: number;
  failureWindowStartedAtMs: number | null;
}

export class McpClientManager {
  private config: McpConfig;
  private readonly transportFactory: McpTransportFactory;
  private readonly servers = new Map<string, ServerRuntime>();
  private generation = 0;
  private started = false;
  private startPromise: Promise<void> | null = null;
  private reloadPromise: Promise<void> | null = null;

  constructor(options: McpClientManagerOptions) {
    this.config = options.config;
    this.transportFactory = options.transportFactory ?? new DefaultMcpTransportFactory();
    this.reconcileStatuses(this.config);
  }

  start(): Promise<void> {
    if (this.started) {
      return this.startPromise ?? Promise.resolve();
    }

    this.started = true;
    this.startPromise = this.startGeneration(this.config, "start").finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  async reload(nextConfig: McpConfig, reason = "config_reload"): Promise<void> {
    this.config = nextConfig;
    if (!this.started) {
      this.reconcileStatuses(nextConfig);
      return;
    }

    this.reloadPromise =
      this.reloadPromise == null
        ? this.replaceGeneration(nextConfig, reason)
        : this.reloadPromise.then(() => this.replaceGeneration(nextConfig, reason));
    try {
      await this.reloadPromise;
    } finally {
      this.reloadPromise = null;
    }
  }

  async shutdown(): Promise<void> {
    this.started = false;
    this.generation += 1;
    const runtimes = [...this.servers.values()];
    for (const runtime of runtimes) {
      this.setStatusState(runtime.status, "closing");
    }

    await Promise.all(runtimes.map((runtime) => this.closeRuntime(runtime)));
    this.servers.clear();
    this.reconcileStatuses(this.config);
  }

  getStatusSnapshot(): McpManagerStatusSnapshot {
    return {
      enabled: this.config.enabled,
      generation: this.generation,
      servers: [...this.servers.values()]
        .map((runtime) => ({ ...runtime.status }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  getConnectedServer(name: string): McpConnectedServer | null {
    return this.servers.get(name)?.connected ?? null;
  }

  getConnectedServers(): McpConnectedServer[] {
    return [...this.servers.values()]
      .map((runtime) => runtime.connected)
      .filter((server): server is McpConnectedServer => server != null);
  }

  async reconnectServer(name: string, reason = "reconnect"): Promise<McpConnectedServer | null> {
    const runtime = this.servers.get(name);
    const serverConfig = this.config.servers[name];
    if (!this.started || runtime == null || serverConfig == null || !this.config.enabled) {
      return null;
    }
    if (!serverConfig.enabled) {
      this.setStatusState(runtime.status, "disabled");
      return null;
    }

    if (runtime.startPromise != null) {
      await runtime.startPromise;
      return this.getConnectedServer(name);
    }

    const generation = this.generation;
    runtime.startPromise = this.reconnectRuntime({
      name,
      reason,
      config: this.config,
      serverConfig,
      generation,
      runtime,
    }).finally(() => {
      runtime.startPromise = null;
    });
    await runtime.startPromise;

    return this.getConnectedServer(name);
  }

  recordCatalogRefreshStarted(serverName: string): void {
    const runtime = this.servers.get(serverName);
    if (runtime?.connected == null || runtime.status.state !== "ready") {
      return;
    }

    this.setStatusState(runtime.status, "refreshing");
  }

  recordCatalogRefreshSucceeded(input: {
    serverName: string;
    catalogVersion: string;
    fetchedAtMs: number;
    expiresAtMs: number;
  }): void {
    const runtime = this.servers.get(input.serverName);
    if (runtime?.connected == null) {
      return;
    }

    this.updateStatus(runtime.status, {
      state: "ready",
      catalogVersion: input.catalogVersion,
      catalogFetchedAt: new Date(input.fetchedAtMs).toISOString(),
      catalogExpiresAt: new Date(input.expiresAtMs).toISOString(),
      lastError: null,
    });
  }

  recordCatalogRefreshFailed(input: { serverName: string; error: unknown }): void {
    const runtime = this.servers.get(input.serverName);
    if (runtime?.connected == null) {
      return;
    }

    this.recordServerOperationFailed(input.serverName, input.error);
  }

  recordServerOperationSucceeded(serverName: string): void {
    const runtime = this.servers.get(serverName);
    if (runtime?.connected == null) {
      return;
    }

    runtime.consecutiveFailures = 0;
    runtime.failureWindowStartedAtMs = null;
    if (runtime.status.state === "degraded" || runtime.status.state === "refreshing") {
      this.updateStatus(runtime.status, {
        state: "ready",
        lastError: null,
      });
    }
  }

  recordServerOperationFailed(serverName: string, error: unknown): void {
    const runtime = this.servers.get(serverName);
    if (runtime?.connected == null) {
      return;
    }

    const now = Date.now();
    if (
      runtime.failureWindowStartedAtMs == null ||
      now - runtime.failureWindowStartedAtMs > runtime.connected.config.failureWindowMs
    ) {
      runtime.failureWindowStartedAtMs = now;
      runtime.consecutiveFailures = 0;
    }

    runtime.consecutiveFailures += 1;
    const nextState =
      runtime.consecutiveFailures >= runtime.connected.config.degradeAfterConsecutiveFailures
        ? "degraded"
        : runtime.status.state === "refreshing"
          ? "ready"
          : runtime.status.state;
    this.updateStatus(runtime.status, {
      state: nextState,
      lastError: sanitizeMcpErrorMessage(error, runtime.connected.config),
    });
  }

  private async replaceGeneration(nextConfig: McpConfig, reason: string): Promise<void> {
    const previous = [...this.servers.values()];
    for (const runtime of previous) {
      this.setStatusState(runtime.status, "closing");
    }

    await Promise.all(previous.map((runtime) => this.closeRuntime(runtime)));
    await this.startGeneration(nextConfig, reason);
  }

  private async reconnectRuntime(input: {
    name: string;
    reason: string;
    config: McpConfig;
    serverConfig: McpServerConfig;
    generation: number;
    runtime: ServerRuntime;
  }): Promise<void> {
    const previousCatalog = {
      catalogVersion: input.runtime.status.catalogVersion,
      catalogFetchedAt: input.runtime.status.catalogFetchedAt,
      catalogExpiresAt: input.runtime.status.catalogExpiresAt,
    };

    this.setStatusState(input.runtime.status, "closing");
    await this.closeRuntime(input.runtime);
    logger.info("reconnecting mcp server", {
      serverName: input.name,
      transport: input.serverConfig.transport,
      reason: input.reason,
      generation: input.generation,
    });
    await this.startServer(input);

    if (input.runtime.connected != null) {
      this.updateStatus(input.runtime.status, {
        ...previousCatalog,
        lastError: null,
      });
    }
  }

  private async startGeneration(config: McpConfig, reason: string): Promise<void> {
    this.generation += 1;
    const generation = this.generation;
    this.reconcileStatuses(config);

    if (!config.enabled) {
      logger.info("mcp manager disabled", {
        reason,
        generation,
        serverCount: Object.keys(config.servers).length,
      });
      return;
    }

    const startPromises = [...Object.entries(config.servers)].map(([name, serverConfig]) => {
      const runtime = this.getOrCreateRuntime(name, serverConfig, generation);
      if (!serverConfig.enabled) {
        this.setStatusState(runtime.status, "disabled");
        return Promise.resolve();
      }

      runtime.startPromise = this.startServer({
        name,
        config,
        serverConfig,
        generation,
        runtime,
      }).finally(() => {
        runtime.startPromise = null;
      });
      return runtime.startPromise;
    });

    await Promise.all(startPromises);
  }

  private async startServer(input: {
    name: string;
    config: McpConfig;
    serverConfig: McpServerConfig;
    generation: number;
    runtime: ServerRuntime;
  }): Promise<void> {
    const { name, serverConfig, runtime } = input;
    const startedAt = nowIso();
    runtime.generation = input.generation;
    runtime.connected = null;
    runtime.consecutiveFailures = 0;
    runtime.failureWindowStartedAtMs = null;
    this.updateStatus(runtime.status, {
      state: "starting",
      startedAt,
      readyAt: null,
      catalogVersion: null,
      catalogFetchedAt: null,
      catalogExpiresAt: null,
      lastError: null,
    });

    let client: Client | null = null;
    let transport: Transport | null = null;
    try {
      transport = this.transportFactory.createTransport({
        serverName: name,
        config: serverConfig,
        managerConfig: input.config,
      });
      client = new Client(
        {
          name: CLIENT_NAME,
          version: CLIENT_VERSION,
        },
        {
          capabilities: {},
        },
      );

      await withTimeout(
        client.connect(transport),
        serverConfig.startupTimeoutMs,
        `MCP server ${name} did not finish startup within ${serverConfig.startupTimeoutMs}ms`,
      );

      if (!this.isCurrentRuntime(name, runtime, input.generation)) {
        await closeMcpConnection(client, transport);
        return;
      }

      runtime.connected = {
        name,
        config: serverConfig,
        configFingerprint: runtime.status.configFingerprint,
        client,
        transport,
      };
      this.updateStatus(runtime.status, {
        state: "ready",
        readyAt: nowIso(),
        lastError: null,
      });
      logger.info("mcp server ready", {
        serverName: name,
        transport: serverConfig.transport,
        generation: input.generation,
      });
    } catch (error) {
      await closeMcpConnection(client, transport);
      this.updateStatus(runtime.status, {
        state: "failed",
        readyAt: null,
        catalogVersion: null,
        catalogFetchedAt: null,
        catalogExpiresAt: null,
        lastError: sanitizeMcpErrorMessage(error, serverConfig),
      });
      logger.warn("mcp server failed to start", {
        serverName: name,
        transport: serverConfig.transport,
        generation: input.generation,
        error: runtime.status.lastError,
      });
    }
  }

  private reconcileStatuses(config: McpConfig): void {
    const nextNames = new Set(Object.keys(config.servers));
    for (const [name, runtime] of this.servers) {
      if (!nextNames.has(name)) {
        this.servers.delete(name);
        void this.closeRuntime(runtime).catch((error: unknown) => {
          logger.warn("failed to close removed mcp server", {
            serverName: name,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    }

    for (const [name, serverConfig] of Object.entries(config.servers)) {
      const runtime = this.getOrCreateRuntime(name, serverConfig, this.generation);
      runtime.status.enabled = config.enabled && serverConfig.enabled;
      runtime.status.transport = serverConfig.transport;
      runtime.status.toolPolicy = serverConfig.toolPolicy;
      runtime.status.configFingerprint = computeStableFingerprint(serverConfig);
      runtime.status.authStatus = getAuthStatus(serverConfig);
      if (!config.enabled || !serverConfig.enabled) {
        this.updateStatus(runtime.status, {
          state: "disabled",
          startedAt: null,
          readyAt: null,
          catalogVersion: null,
          catalogFetchedAt: null,
          catalogExpiresAt: null,
          lastError: null,
        });
      }
    }
  }

  private getOrCreateRuntime(
    name: string,
    config: McpServerConfig,
    generation: number,
  ): ServerRuntime {
    const existing = this.servers.get(name);
    const fingerprint = computeStableFingerprint(config);
    if (existing != null) {
      return existing;
    }

    const runtime: ServerRuntime = {
      status: {
        name,
        state: "disabled",
        enabled: config.enabled,
        transport: config.transport,
        toolPolicy: config.toolPolicy,
        configFingerprint: fingerprint,
        authStatus: getAuthStatus(config),
        startedAt: null,
        readyAt: null,
        catalogVersion: null,
        catalogFetchedAt: null,
        catalogExpiresAt: null,
        updatedAt: nowIso(),
        lastError: null,
      },
      connected: null,
      startPromise: null,
      generation,
      consecutiveFailures: 0,
      failureWindowStartedAtMs: null,
    };
    this.servers.set(name, runtime);
    return runtime;
  }

  private async closeRuntime(runtime: ServerRuntime): Promise<void> {
    const connected = runtime.connected;
    runtime.connected = null;
    if (connected == null) {
      return;
    }

    await closeMcpConnection(connected.client, connected.transport);
  }

  private isCurrentRuntime(name: string, runtime: ServerRuntime, generation: number): boolean {
    return this.started && this.generation === generation && this.servers.get(name) === runtime;
  }

  private setStatusState(status: MutableMcpServerStatus, state: McpServerLifecycleState): void {
    this.updateStatus(status, { state });
  }

  private updateStatus(
    status: MutableMcpServerStatus,
    patch: Partial<Omit<MutableMcpServerStatus, "name">>,
  ): void {
    Object.assign(status, patch);
    status.updatedAt = nowIso();
  }
}

function getAuthStatus(config: McpServerConfig): McpAuthStatus {
  if (config.transport === "stdio") {
    return "none";
  }

  const hasBearer = config.bearerToken != null && config.bearerToken.length > 0;
  const hasHeaders = Object.keys(config.headers).length > 0;
  if (hasBearer && hasHeaders) {
    return "bearer_and_headers";
  }
  if (hasBearer) {
    return "bearer";
  }
  if (hasHeaders) {
    return "static_headers";
  }
  return "none";
}

function sanitizeMcpErrorMessage(error: unknown, config: McpServerConfig): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of collectSecretValues(config)) {
    if (secret.length === 0) {
      continue;
    }
    message = message.split(secret).join("[redacted]");
  }

  return message.trim().length > 0 ? message : "Unknown MCP connection error";
}

function collectSecretValues(config: McpServerConfig): string[] {
  if (config.transport === "stdio") {
    return Object.values(config.env);
  }

  return [config.bearerToken ?? "", ...Object.values(config.headers)];
}

async function closeMcpConnection(
  client: Client | null,
  transport: Transport | null,
): Promise<void> {
  if (client != null) {
    try {
      await client.close();
      return;
    } catch {
      // Fall through to transport close so reload/shutdown still releases handles.
    }
  }

  if (transport != null) {
    await transport.close();
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(
      () => {
        reject(new Error(message));
      },
      Math.max(1, timeoutMs),
    );
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutHandle != null) {
      clearTimeout(timeoutHandle);
    }
  });
}

function nowIso(): string {
  return new Date().toISOString();
}
