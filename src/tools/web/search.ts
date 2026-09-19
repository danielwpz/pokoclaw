import { type Static, Type } from "@sinclair/typebox";
import { defineTool, jsonToolResult } from "@/src/tools/core/types.js";
import { executeWebProviderChain } from "@/src/tools/web/provider-chain.js";
import { WebProviderGovernor } from "@/src/tools/web/provider-governor.js";
import { createSearchProvider, type WebProviderConfigInput } from "@/src/tools/web/providers.js";
import { webProviderChainToToolFailure } from "@/src/tools/web/tool-failure.js";

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

export function createWebSearchTool(
  input: WebProviderConfigInput & {
    fallbackProvider?: WebProviderConfigInput;
    governor?: WebProviderGovernor;
  },
) {
  const provider = createSearchProvider(input);
  const fallbackProvider =
    input.fallbackProvider == null ? undefined : createSearchProvider(input.fallbackProvider);
  const governor = input.governor ?? new WebProviderGovernor();

  return defineTool({
    name: "web_search",
    description: "Search the web using the configured web services.",
    inputSchema: WEB_SEARCH_TOOL_SCHEMA,
    getInvocationTimeoutMs() {
      return 90_000;
    },
    async execute(context, args) {
      try {
        const response = await executeWebProviderChain({
          toolName: "web_search",
          context,
          primary: provider,
          governor,
          ...(fallbackProvider == null ? {} : { fallback: fallbackProvider }),
          execute: (candidate) =>
            candidate.search({
              query: args.query,
              maxResults: args.maxResults ?? DEFAULT_MAX_RESULTS,
              ...(context.abortSignal == null ? {} : { signal: context.abortSignal }),
            }),
          summarizeResponse: (result) => ({ resultCount: result.results.length }),
        });
        return jsonToolResult({
          query: response.query,
          ...(response.answer == null ? {} : { answer: response.answer }),
          results: response.results,
        });
      } catch (error) {
        throw webProviderChainToToolFailure("web_search", error);
      }
    },
  });
}
