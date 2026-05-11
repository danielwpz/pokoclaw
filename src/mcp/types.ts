import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  McpConfig,
  McpServerConfig,
  McpToolPolicy,
  McpTransport,
} from "@/src/config/schema.js";

export type McpServerLifecycleState =
  | "disabled"
  | "starting"
  | "ready"
  | "failed"
  | "degraded"
  | "refreshing"
  | "closing";

export type McpAuthStatus = "none" | "bearer" | "static_headers" | "bearer_and_headers";

export interface McpServerStatusSnapshot {
  name: string;
  state: McpServerLifecycleState;
  enabled: boolean;
  transport: McpTransport;
  toolPolicy: McpToolPolicy;
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

export interface McpManagerStatusSnapshot {
  enabled: boolean;
  generation: number;
  servers: McpServerStatusSnapshot[];
}

export interface McpConnectedServer {
  name: string;
  config: McpServerConfig;
  configFingerprint: string;
  client: Client;
  transport: Transport;
}

export interface McpTransportFactory {
  createTransport(input: {
    serverName: string;
    config: McpServerConfig;
    managerConfig: McpConfig;
  }): Transport;
}
