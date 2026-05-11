import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  McpConfig,
  McpServerConfig,
  McpStdioServerConfig,
  McpStreamableHttpServerConfig,
} from "@/src/config/schema.js";
import type { McpTransportFactory } from "@/src/mcp/types.js";

export class DefaultMcpTransportFactory implements McpTransportFactory {
  createTransport(input: {
    serverName: string;
    config: McpServerConfig;
    managerConfig: McpConfig;
  }): Transport {
    return createMcpTransport(input.config);
  }
}

export function createMcpTransport(config: McpServerConfig): Transport {
  switch (config.transport) {
    case "stdio":
      return createStdioTransport(config);
    case "streamable_http":
      return createStreamableHttpTransport(config) as unknown as Transport;
    default:
      return assertNever(config);
  }
}

export function buildStreamableHttpHeaders(
  config: McpStreamableHttpServerConfig,
): Record<string, string> {
  const headers: Record<string, string> = { ...config.headers };
  if (config.bearerToken != null && config.bearerToken.length > 0) {
    headers.Authorization = `Bearer ${config.bearerToken}`;
  }

  return headers;
}

function createStdioTransport(config: McpStdioServerConfig): StdioClientTransport {
  const params: ConstructorParameters<typeof StdioClientTransport>[0] = {
    command: config.command,
    stderr: "pipe",
  };
  if (config.args.length > 0) {
    params.args = config.args;
  }
  if (Object.keys(config.env).length > 0) {
    params.env = config.env;
  }

  return new StdioClientTransport(params);
}

function createStreamableHttpTransport(
  config: McpStreamableHttpServerConfig,
): StreamableHTTPClientTransport {
  return new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: {
      headers: buildStreamableHttpHeaders(config),
    },
  });
}

function assertNever(value: never): never {
  throw new Error(`Unsupported MCP transport config: ${JSON.stringify(value)}`);
}
