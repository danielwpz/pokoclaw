import { createSubsystemLogger } from "@/src/shared/logger.js";
import type { ToolExecutionContext } from "@/src/tools/core/types.js";
import {
  normalizeWebProviderFailure,
  WebProviderError,
  type WebProviderFailure,
} from "@/src/tools/web/provider-errors.js";

const logger = createSubsystemLogger("web-provider");

interface ProviderIdentity {
  readonly providerId: string;
  readonly providerApi: string;
}

interface ProviderResponseDiagnostics {
  requestId?: string;
  responseTimeMs?: number;
  creditsUsed?: number;
}

export interface WebProviderChainFailure {
  readonly failure: WebProviderFailure;
  readonly role: "primary" | "fallback";
}

export class WebProviderChainError extends Error {
  readonly failures: readonly WebProviderChainFailure[];

  constructor(failures: readonly WebProviderChainFailure[]) {
    super("All configured web providers failed.");
    this.name = "WebProviderChainError";
    this.failures = failures;
  }
}

export async function executeWebProviderChain<
  TProvider extends ProviderIdentity,
  TResponse extends ProviderResponseDiagnostics,
>(input: {
  toolName: "web_search" | "web_fetch";
  context: ToolExecutionContext;
  primary: TProvider;
  fallback?: TProvider;
  execute: (provider: TProvider) => Promise<TResponse>;
  summarizeResponse?: (response: TResponse) => Record<string, unknown>;
}): Promise<TResponse> {
  const providers: Array<{ provider: TProvider; role: "primary" | "fallback" }> = [
    { provider: input.primary, role: "primary" },
    ...(input.fallback == null ? [] : [{ provider: input.fallback, role: "fallback" as const }]),
  ];
  const failures: WebProviderChainFailure[] = [];

  for (const [index, attempt] of providers.entries()) {
    if (input.context.abortSignal?.aborted) {
      failures.push({
        role: attempt.role,
        failure: normalizeWebProviderFailure(
          new WebProviderError({
            code: "aborted",
            message: "Provider request was aborted.",
            retryable: false,
          }),
        ),
      });
      break;
    }

    const startedAt = Date.now();
    try {
      const response = await input.execute(attempt.provider);
      logger.info("web provider attempt succeeded", {
        toolName: input.toolName,
        toolCallId: input.context.toolCallId,
        sessionId: input.context.sessionId,
        role: attempt.role,
        providerId: attempt.provider.providerId,
        providerApi: attempt.provider.providerApi,
        durationMs: Date.now() - startedAt,
        fallbackUsed: attempt.role === "fallback",
        requestId: response.requestId,
        upstreamResponseTimeMs: response.responseTimeMs,
        creditsUsed: response.creditsUsed,
        ...input.summarizeResponse?.(response),
      });
      return response;
    } catch (error) {
      const failure = normalizeWebProviderFailure(error);
      failures.push({ role: attempt.role, failure });
      logger.warn("web provider attempt failed", {
        toolName: input.toolName,
        toolCallId: input.context.toolCallId,
        sessionId: input.context.sessionId,
        role: attempt.role,
        providerId: attempt.provider.providerId,
        providerApi: attempt.provider.providerApi,
        durationMs: Date.now() - startedAt,
        failureCode: failure.code,
        retryable: failure.retryable,
        statusCode: failure.statusCode,
        errorMessage: failure.message,
      });

      if (
        failure.code === "aborted" ||
        input.context.abortSignal?.aborted ||
        index === providers.length - 1
      ) {
        break;
      }

      const fallback = providers[index + 1];
      logger.info("web provider fallback starting", {
        toolName: input.toolName,
        toolCallId: input.context.toolCallId,
        sessionId: input.context.sessionId,
        failedProviderId: attempt.provider.providerId,
        fallbackProviderId: fallback?.provider.providerId,
        failureCode: failure.code,
      });
    }
  }

  logger.error("web provider chain exhausted", {
    toolName: input.toolName,
    toolCallId: input.context.toolCallId,
    sessionId: input.context.sessionId,
    attemptCount: failures.length,
    failureCodes: failures.map(({ failure }) => failure.code),
    retryable: failures.some(({ failure }) => failure.retryable),
  });
  throw new WebProviderChainError(failures);
}
