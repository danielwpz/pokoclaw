import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpToolPolicy } from "@/src/config/schema.js";
import type { McpCatalogService, McpCatalogTool } from "@/src/mcp/catalog.js";
import type { McpClientManager } from "@/src/mcp/manager.js";
import { SecurityService } from "@/src/security/service.js";
import { toolApprovalRequired, toolRecoverableError } from "@/src/tools/core/errors.js";
import { ajvJsonSchemaToolInputSchema } from "@/src/tools/core/json-schema.js";
import type { ToolSource } from "@/src/tools/core/source.js";
import type {
  ToolContentBlock,
  ToolDefinition,
  ToolExecutionContext,
  ToolResult,
  ToolSourceMetadata,
} from "@/src/tools/core/types.js";

type McpCallToolResult = Awaited<ReturnType<Client["callTool"]>>;

export const MCP_TOOL_SOURCE_METADATA: ToolSourceMetadata = {
  kind: "mcp",
  id: "mcp",
  displayName: "MCP tools",
  diagnosticsName: "mcp",
};

export interface McpToolSourceOptions {
  manager: McpClientManager;
  catalog: McpCatalogService;
}

export class McpToolSource implements ToolSource {
  readonly metadata = MCP_TOOL_SOURCE_METADATA;

  constructor(private readonly options: McpToolSourceOptions) {}

  list(): readonly ToolDefinition[] {
    return this.options.catalog.listCachedTools().map((tool) => this.createToolDefinition(tool));
  }

  private createToolDefinition(tool: McpCatalogTool): ToolDefinition<Record<string, unknown>> {
    return {
      name: tool.name,
      description: tool.description,
      source: {
        kind: "mcp",
        id: `mcp:${tool.serverName}`,
        displayName: `MCP ${tool.serverName}`,
        diagnosticsName: `mcp:${tool.serverName}`,
      },
      inputSchemaSpec: ajvJsonSchemaToolInputSchema<Record<string, unknown>>(tool.inputSchema),
      getInvocationTimeoutMs: () =>
        this.options.manager.getConnectedServer(tool.serverName)?.config.toolTimeoutMs ?? 1,
      execute: async (context, args) => await this.executeMcpTool(context, tool, args),
    };
  }

  private async executeMcpTool(
    context: ToolExecutionContext,
    tool: McpCatalogTool,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const currentTool = this.options.catalog.findCachedToolByName(tool.name);
    if (
      currentTool == null ||
      currentTool.serverFingerprint !== tool.serverFingerprint ||
      currentTool.catalogVersion !== tool.catalogVersion
    ) {
      throw toolRecoverableError(
        `MCP tool ${tool.name} changed or is no longer available. Refresh tools and try again.`,
        {
          code: "mcp_tool_catalog_changed",
          toolName: tool.name,
          serverName: tool.serverName,
          remoteName: tool.remoteName,
        },
      );
    }

    const connected = this.options.manager.getConnectedServer(tool.serverName);
    if (connected == null || connected.configFingerprint !== tool.serverFingerprint) {
      throw toolRecoverableError(`MCP server ${tool.serverName} is not connected.`, {
        code: "mcp_server_unavailable",
        serverName: tool.serverName,
        remoteName: tool.remoteName,
      });
    }

    this.assertMcpToolApproved(context, currentTool, connected.config.toolPolicy);

    try {
      const result = await this.callMcpTool(context, connected, tool, args);
      this.options.manager.recordServerOperationSucceeded(tool.serverName);
      return toToolResult({
        tool,
        result,
      });
    } catch (error) {
      if (isStreamableHttpSessionExpired(error, connected.config.transport)) {
        try {
          const reconnected = await this.options.manager.reconnectServer(
            tool.serverName,
            "streamable_http_session_expired",
          );
          if (reconnected == null || reconnected.configFingerprint !== tool.serverFingerprint) {
            throw new Error(`MCP server ${tool.serverName} could not recover expired session.`);
          }

          const retryResult = await this.callMcpTool(context, reconnected, tool, args);
          this.options.manager.recordServerOperationSucceeded(tool.serverName);
          return toToolResult({
            tool,
            result: retryResult,
          });
        } catch (retryError) {
          this.options.manager.recordServerOperationFailed(tool.serverName, retryError);
          throw toolRecoverableError(
            `MCP tool ${tool.serverName}/${tool.remoteName} failed after session recovery.`,
            {
              code: "mcp_tool_call_failed",
              serverName: tool.serverName,
              remoteName: tool.remoteName,
              message: retryError instanceof Error ? retryError.message : String(retryError),
            },
          );
        }
      }

      this.options.manager.recordServerOperationFailed(tool.serverName, error);
      throw toolRecoverableError(`MCP tool ${tool.serverName}/${tool.remoteName} failed.`, {
        code: "mcp_tool_call_failed",
        serverName: tool.serverName,
        remoteName: tool.remoteName,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async callMcpTool(
    context: ToolExecutionContext,
    connected: NonNullable<ReturnType<McpClientManager["getConnectedServer"]>>,
    tool: McpCatalogTool,
    args: Record<string, unknown>,
  ): Promise<McpCallToolResult> {
    return await connected.client.callTool(
      {
        name: tool.remoteName,
        arguments: args,
      },
      undefined,
      {
        timeout: connected.config.toolTimeoutMs,
        ...(context.abortSignal == null ? {} : { signal: context.abortSignal }),
      },
    );
  }

  private assertMcpToolApproved(
    context: ToolExecutionContext,
    tool: McpCatalogTool,
    toolPolicy: McpToolPolicy,
  ): void {
    const scope = buildMcpToolScope(tool);
    const request = {
      scopes: [scope],
    };
    const ownerAgentId = context.ownerAgentId ?? "";
    const security = new SecurityService(context.storage);
    const activeGrant = security.checkMcpToolAccess({
      ownerAgentId,
      server: tool.serverName,
      tool: tool.remoteName,
      serverFingerprint: tool.serverFingerprint,
      catalogVersion: tool.catalogVersion,
      ...(context.approvalState?.ephemeralPermissionScopes == null
        ? {}
        : { ephemeralScopes: context.approvalState.ephemeralPermissionScopes }),
    });
    if (activeGrant.result === "allow") {
      return;
    }

    if (toolPolicy === "always_allow" || isAutoAllowedMcpTool(toolPolicy, tool)) {
      return;
    }

    throw toolApprovalRequired({
      request,
      reasonText: `MCP tool ${tool.serverName}/${tool.remoteName} requires approval.`,
      approvalTitle: `Approval required: MCP ${tool.serverName}/${tool.remoteName}`,
      approvalCommand: renderMcpApprovalCommand(tool, scope.catalogVersion),
      grantOnApprove: true,
      ...(context.approvalState == null ? {} : { approvalState: context.approvalState }),
    });
  }
}

function buildMcpToolScope(tool: McpCatalogTool) {
  return {
    kind: "mcp.tool" as const,
    server: tool.serverName,
    tool: tool.remoteName,
    serverFingerprint: tool.serverFingerprint,
    catalogVersion: tool.catalogVersion,
  };
}

function isAutoAllowedMcpTool(policy: McpToolPolicy, tool: McpCatalogTool): boolean {
  if (policy !== "auto") {
    return false;
  }

  return (
    tool.annotations?.readOnlyHint === true &&
    tool.annotations.destructiveHint !== true &&
    tool.annotations.openWorldHint !== true
  );
}

function renderMcpApprovalCommand(tool: McpCatalogTool, catalogVersion: string): string {
  return [
    `tool: ${tool.name}`,
    `server: ${tool.serverName}`,
    `remote_tool: ${tool.remoteName}`,
    `catalog: ${catalogVersion}`,
  ].join("\n");
}

function toToolResult(input: { tool: McpCatalogTool; result: McpCallToolResult }): ToolResult {
  const content = convertMcpContent(input.result);
  return {
    content,
    details: {
      mcp: {
        serverName: input.tool.serverName,
        remoteName: input.tool.remoteName,
        modelName: input.tool.name,
        catalogVersion: input.tool.catalogVersion,
        ...(readMcpIsError(input.result) ? { isError: true } : {}),
        ...("structuredContent" in input.result && input.result.structuredContent !== undefined
          ? { structuredContent: input.result.structuredContent }
          : {}),
      },
    },
  };
}

function convertMcpContent(result: McpCallToolResult): ToolContentBlock[] {
  if ("content" in result && Array.isArray(result.content) && result.content.length > 0) {
    return result.content.map((block) =>
      block.type === "text"
        ? {
            type: "text" as const,
            text: block.text,
          }
        : {
            type: "json" as const,
            json: block,
          },
    );
  }

  if ("structuredContent" in result && result.structuredContent !== undefined) {
    return [
      {
        type: "json",
        json: result.structuredContent,
      },
    ];
  }

  if ("toolResult" in result) {
    return [
      {
        type: "json",
        json: result.toolResult,
      },
    ];
  }

  return [
    {
      type: "text",
      text: readMcpIsError(result)
        ? "MCP tool returned an error."
        : "MCP tool returned no content.",
    },
  ];
}

function readMcpIsError(result: McpCallToolResult): boolean {
  return "isError" in result && result.isError === true;
}

function isStreamableHttpSessionExpired(error: unknown, transport: string): boolean {
  return (
    transport === "streamable_http" && error instanceof StreamableHTTPError && error.code === 404
  );
}
