import { type Static, Type } from "@sinclair/typebox";
import type { ProviderConfig } from "@/src/config/schema.js";
import { toolRecoverableError } from "@/src/tools/core/errors.js";
import { defineTool, jsonToolResult } from "@/src/tools/core/types.js";
import { createSearchProvider } from "@/src/tools/web/providers.js";

const DEFAULT_MAX_RESULTS = 5;

export const WEB_SEARCH_TOOL_SCHEMA = Type.Object(
  {
    query: Type.String({
      minLength: 1,
      description: "Search query to run on the web.",
    }),
    maxResults: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 10,
        description: "Maximum number of search results to return.",
      }),
    ),
  },
  { additionalProperties: false },
);

export type WebSearchToolArgs = Static<typeof WEB_SEARCH_TOOL_SCHEMA>;

export function createWebSearchTool(input: { providerId: string; providerConfig: ProviderConfig }) {
  const provider = createSearchProvider(input);

  return defineTool({
    name: "web_search",
    description: "Search the web using the configured provider.",
    inputSchema: WEB_SEARCH_TOOL_SCHEMA,
    async execute(_context, args) {
      try {
        const response = await provider.search({
          query: args.query,
          maxResults: args.maxResults ?? DEFAULT_MAX_RESULTS,
        });
        return jsonToolResult(response);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw toolRecoverableError(`web_search failed: ${message}`, {
          code: "web_search_failed",
          providerId: input.providerId,
          providerApi: input.providerConfig.api,
        });
      }
    },
  });
}
