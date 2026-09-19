import { createSubsystemLogger } from "@/src/shared/logger.js";
import {
  normalizeWebProviderFailure,
  WebProviderError,
  type WebProviderFailure,
} from "@/src/tools/web/provider-errors.js";

const logger = createSubsystemLogger("web-provider-governor");

export const DEFAULT_WEB_PROVIDER_MAX_QUEUE_SIZE = 100;
export const DEFAULT_WEB_PROVIDER_MAX_MANAGED_WAIT_MS = 60_000;
export const DEFAULT_WEB_PROVIDER_RATE_LIMIT_RETRY_MS = 1_000;
export const DEFAULT_WEB_PROVIDER_RATE_LIMIT_JITTER_MS = 250;
export const DEFAULT_WEB_PROVIDER_REPROBE_MS = 15 * 60_000;

interface ProviderLane {
  tail: Promise<void>;
  queued: number;
  blockedUntil: number;
}

interface ProviderBlock {
  failure: WebProviderFailure;
  blockedUntil: number;
}

interface GovernorClock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface WebProviderGovernorOptions {
  maxQueueSize?: number;
  maxManagedWaitMs?: number;
  rateLimitRetryMs?: number;
  rateLimitJitterMs?: number;
  providerReprobeMs?: number;
  clock?: GovernorClock;
}

export class WebProviderGovernor {
  private readonly lanes = new Map<string, ProviderLane>();
  private readonly providerBlocks = new Map<string, ProviderBlock>();
  private readonly maxQueueSize: number;
  private readonly maxManagedWaitMs: number;
  private readonly rateLimitRetryMs: number;
  private readonly rateLimitJitterMs: number;
  private readonly providerReprobeMs: number;
  private readonly clock: GovernorClock;

  constructor(options: WebProviderGovernorOptions = {}) {
    this.maxQueueSize = options.maxQueueSize ?? DEFAULT_WEB_PROVIDER_MAX_QUEUE_SIZE;
    this.maxManagedWaitMs = options.maxManagedWaitMs ?? DEFAULT_WEB_PROVIDER_MAX_MANAGED_WAIT_MS;
    this.rateLimitRetryMs = options.rateLimitRetryMs ?? DEFAULT_WEB_PROVIDER_RATE_LIMIT_RETRY_MS;
    this.rateLimitJitterMs = options.rateLimitJitterMs ?? DEFAULT_WEB_PROVIDER_RATE_LIMIT_JITTER_MS;
    this.providerReprobeMs = options.providerReprobeMs ?? DEFAULT_WEB_PROVIDER_REPROBE_MS;
    this.clock = options.clock ?? SYSTEM_CLOCK;
  }

  async execute<T>(input: {
    toolName: "web_search" | "web_fetch";
    providerId: string;
    providerApi: string;
    signal?: AbortSignal;
    waitForRateLimit: boolean;
    execute: () => Promise<T>;
  }): Promise<T> {
    const startedAt = this.clock.now();
    const deadline = startedAt + this.maxManagedWaitMs;
    const lane = this.getLane(input.toolName, input.providerId);
    const release = await this.acquireLane(lane, input, deadline);

    try {
      this.throwIfProviderBlocked(input);
      let managedRateLimitRetries = 0;

      while (true) {
        await this.waitForCooldown(lane, input, deadline);
        try {
          const result = await input.execute();
          return result;
        } catch (error) {
          const failure = normalizeWebProviderFailure(error);
          if (failure.code === "authentication" || failure.code === "quota_exhausted") {
            this.providerBlocks.set(input.providerId, {
              failure,
              blockedUntil: this.clock.now() + this.providerReprobeMs,
            });
            logger.warn("web provider temporarily removed from routing", {
              toolName: input.toolName,
              providerId: input.providerId,
              providerApi: input.providerApi,
              failureCode: failure.code,
              reprobeAfterMs: this.providerReprobeMs,
            });
          }

          if (failure.code !== "rate_limited") {
            throw toWebProviderError(failure);
          }

          const cooldownMs =
            (failure.retryAfterMs ?? this.rateLimitRetryMs) + this.rateLimitJitterMs;
          lane.blockedUntil = Math.max(lane.blockedUntil, this.clock.now() + cooldownMs);
          logger.warn("web provider rate limit cooldown started", {
            toolName: input.toolName,
            providerId: input.providerId,
            providerApi: input.providerApi,
            retryAfterMs: failure.retryAfterMs,
            cooldownMs,
            waitManagedByHost: input.waitForRateLimit,
          });

          if (
            !input.waitForRateLimit ||
            managedRateLimitRetries >= 1 ||
            lane.blockedUntil > deadline
          ) {
            throw toWebProviderError(failure);
          }

          managedRateLimitRetries += 1;
          logger.info("web provider retry waiting in host", {
            toolName: input.toolName,
            providerId: input.providerId,
            providerApi: input.providerApi,
            attempt: managedRateLimitRetries + 1,
          });
        }
      }
    } finally {
      release();
    }
  }

  private getLane(toolName: "web_search" | "web_fetch", providerId: string): ProviderLane {
    const key = `${providerId}:${toolName}`;
    const existing = this.lanes.get(key);
    if (existing != null) {
      return existing;
    }
    const lane: ProviderLane = {
      tail: Promise.resolve(),
      queued: 0,
      blockedUntil: 0,
    };
    this.lanes.set(key, lane);
    return lane;
  }

  private async acquireLane(
    lane: ProviderLane,
    input: {
      toolName: "web_search" | "web_fetch";
      providerId: string;
      providerApi: string;
      signal?: AbortSignal;
    },
    deadline: number,
  ): Promise<() => void> {
    if (lane.queued >= this.maxQueueSize) {
      throw new WebProviderError({
        code: "rate_limited",
        message: "The host web provider queue is full.",
        retryable: true,
      });
    }

    const previous = lane.tail;
    let releaseCurrent!: () => void;
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    lane.tail = previous.then(() => current);
    lane.queued += 1;

    try {
      await waitForPromise(previous, Math.max(0, deadline - this.clock.now()), input.signal);
      lane.queued -= 1;
      return releaseCurrent;
    } catch (error) {
      lane.queued -= 1;
      releaseCurrent();
      throw error;
    }
  }

  private throwIfProviderBlocked(input: {
    toolName: "web_search" | "web_fetch";
    providerId: string;
    providerApi: string;
  }): void {
    const block = this.providerBlocks.get(input.providerId);
    if (block == null) {
      return;
    }
    if (block.blockedUntil <= this.clock.now()) {
      this.providerBlocks.delete(input.providerId);
      logger.info("web provider routing probe enabled", {
        toolName: input.toolName,
        providerId: input.providerId,
        providerApi: input.providerApi,
      });
      return;
    }
    logger.info("web provider attempt skipped by host", {
      toolName: input.toolName,
      providerId: input.providerId,
      providerApi: input.providerApi,
      failureCode: block.failure.code,
    });
    throw toWebProviderError(block.failure);
  }

  private async waitForCooldown(
    lane: ProviderLane,
    input: {
      toolName: "web_search" | "web_fetch";
      providerId: string;
      providerApi: string;
      signal?: AbortSignal;
      waitForRateLimit: boolean;
    },
    deadline: number,
  ): Promise<void> {
    const waitMs = lane.blockedUntil - this.clock.now();
    if (waitMs <= 0) {
      return;
    }
    if (!input.waitForRateLimit || lane.blockedUntil > deadline) {
      throw new WebProviderError({
        code: "rate_limited",
        message: "The web provider is in a host-managed rate limit cooldown.",
        retryable: true,
        retryAfterMs: waitMs,
      });
    }
    logger.info("web provider request queued during cooldown", {
      toolName: input.toolName,
      providerId: input.providerId,
      providerApi: input.providerApi,
      queueDepth: lane.queued,
    });
    await this.clock.sleep(waitMs, input.signal);
  }
}

const SYSTEM_CLOCK: GovernorClock = {
  now: () => Date.now(),
  sleep: waitWithAbort,
};

function toWebProviderError(failure: WebProviderFailure): WebProviderError {
  return new WebProviderError({
    code: failure.code,
    message: failure.message,
    retryable: failure.retryable,
    ...(failure.statusCode == null ? {} : { statusCode: failure.statusCode }),
    ...(failure.retryAfterMs == null ? {} : { retryAfterMs: failure.retryAfterMs }),
  });
}

function waitForPromise(
  promise: Promise<void>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(abortedError());
  }
  if (timeoutMs <= 0) {
    return Promise.reject(queueWaitExpiredError());
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(() => reject(queueWaitExpiredError())), timeoutMs);
    const onAbort = () => finish(() => reject(abortedError()));
    const finish = (settle: () => void) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      settle();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(
      () => finish(resolve),
      (error) => finish(() => reject(error)),
    );
  });
}

function waitWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(abortedError());
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(resolve), ms);
    const onAbort = () => finish(() => reject(abortedError()));
    const finish = (settle: () => void) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      settle();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortedError(): WebProviderError {
  return new WebProviderError({
    code: "aborted",
    message: "Provider request was aborted.",
    retryable: false,
  });
}

function queueWaitExpiredError(): WebProviderError {
  return new WebProviderError({
    code: "rate_limited",
    message: "The host web provider queue wait budget was exhausted.",
    retryable: true,
  });
}
