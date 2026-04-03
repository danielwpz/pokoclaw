import { type Static, Type } from "@sinclair/typebox";
import type { ProviderConfig } from "@/src/config/schema.js";
import { buildSystemPolicy } from "@/src/security/policy.js";
import { toolRecoverableError } from "@/src/tools/core/errors.js";
import { defineTool, jsonToolResult, type ToolExecutionContext } from "@/src/tools/core/types.js";
import { createFetchProvider } from "@/src/tools/web/providers.js";

const MAX_CONTENT_CHARS = 100_000;
const WEB_FETCH_RESULT_MAX_CHARS = 8_000;

export const WEB_FETCH_TOOL_SCHEMA = Type.Object(
  {
    url: Type.String({
      minLength: 1,
      description: "HTTP or HTTPS URL to fetch and extract.",
    }),
  },
  { additionalProperties: false },
);

export type WebFetchToolArgs = Static<typeof WEB_FETCH_TOOL_SCHEMA>;

export function createWebFetchTool(input: { providerId: string; providerConfig: ProviderConfig }) {
  const provider = createFetchProvider(input);

  return defineTool({
    name: "web_fetch",
    description: "Fetch and extract the main content of a web page using the configured provider.",
    inputSchema: WEB_FETCH_TOOL_SCHEMA,
    getResultMaxChars() {
      return WEB_FETCH_RESULT_MAX_CHARS;
    },
    async execute(context, args) {
      const targetUrl = parseAllowedFetchUrl(context, args.url);

      try {
        const response = await provider.fetch({
          url: targetUrl.toString(),
        });
        const content =
          response.content.length > MAX_CONTENT_CHARS
            ? response.content.slice(0, MAX_CONTENT_CHARS)
            : response.content;

        return jsonToolResult({
          ...response,
          content,
          truncated: content.length < response.content.length,
          originalContentLength: response.content.length,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw toolRecoverableError(`web_fetch failed: ${message}`, {
          code: "web_fetch_failed",
          providerId: input.providerId,
          providerApi: input.providerConfig.api,
          url: targetUrl.toString(),
        });
      }
    },
  });
}

export { MAX_CONTENT_CHARS, WEB_FETCH_RESULT_MAX_CHARS };

function parseAllowedFetchUrl(context: ToolExecutionContext, rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw toolRecoverableError(`Invalid URL: ${rawUrl}`, {
      code: "web_fetch_invalid_url",
      url: rawUrl,
    });
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw toolRecoverableError("web_fetch only supports http and https URLs.", {
      code: "web_fetch_invalid_protocol",
      url: rawUrl,
      protocol: parsed.protocol,
    });
  }

  const deniedHosts = buildSystemPolicy({ security: context.securityConfig }).network.hardDenyHosts;
  if (deniedHosts.includes(parsed.hostname)) {
    throw toolRecoverableError(`Network access to ${parsed.hostname} is blocked by policy.`, {
      code: "web_fetch_host_denied",
      host: parsed.hostname,
      url: parsed.toString(),
    });
  }

  return parsed;
}
