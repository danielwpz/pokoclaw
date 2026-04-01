import { refreshOpenAICodexToken } from "@mariozechner/pi-ai/oauth";
import type { ResolvedProvider } from "@/src/agent/llm/models.js";
import type { ProviderApiKeyResolver } from "@/src/agent/llm/pi-bridge.js";
import { withFileLock } from "@/src/shared/file-lock.js";
import { CODEX_CREDENTIALS_PATH } from "@/src/shared/paths.js";
import {
  type CodexCredentialRecord,
  readCodexSourceFingerprint,
  readLocalCodexCredential,
} from "./local-auth.js";
import { readStoredCodexCredential, writeStoredCodexCredential } from "./store.js";

// Codex-local auth is intentionally only valid for the built-in Codex transport.
// This prevents accidentally forwarding ChatGPT/Codex bearer tokens to arbitrary
// third-party endpoints via a misconfigured provider.
export class CodexProviderApiKeyResolver implements ProviderApiKeyResolver {
  async resolveApiKey(provider: ResolvedProvider): Promise<string | undefined> {
    if (provider.authSource !== "codex-local") {
      return provider.apiKey;
    }
    if (provider.api !== "openai-codex-responses") {
      throw new Error(
        `Provider "${provider.id}" cannot use authSource = "codex-local" unless api = "openai-codex-responses"`,
      );
    }

    const credential = await resolveCodexCredential();
    return credential?.accessToken;
  }
}

async function resolveCodexCredential() {
  const external = readLocalCodexCredential();
  const stored = await readStoredCodexCredential();
  const merged = mergePreferredCredential(stored, external);

  if (merged == null) {
    return null;
  }

  if (Date.now() < merged.expiresAt) {
    if (shouldPersistMergedCredential(stored, merged)) {
      await persistCredential(merged);
    }
    return merged;
  }

  return await withFileLock(CODEX_CREDENTIALS_PATH, async () => {
    const currentStored = await readStoredCodexCredential();
    const currentExternal = readLocalCodexCredential();
    const current = mergePreferredCredential(currentStored, currentExternal);
    if (current == null) {
      return null;
    }
    if (Date.now() < current.expiresAt) {
      if (shouldPersistMergedCredential(currentStored, current)) {
        await persistCredential(current);
      }
      return current;
    }

    const refreshed = await refreshOpenAICodexToken(current.refreshToken);
    const next = {
      accessToken: refreshed.access,
      refreshToken: refreshed.refresh,
      expiresAt: refreshed.expires,
      updatedAt: Date.now(),
      ...(typeof refreshed.accountId === "string" ? { accountId: refreshed.accountId } : {}),
      ...(currentExternal?.sourceFingerprint != null
        ? { sourceFingerprint: currentExternal.sourceFingerprint }
        : current.sourceFingerprint != null
          ? { sourceFingerprint: current.sourceFingerprint }
          : {}),
    };
    await writeStoredCodexCredential(next);
    return next;
  });
}

function mergePreferredCredential(
  stored: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    accountId?: string;
    sourceFingerprint?: string;
    updatedAt: number;
  } | null,
  external: CodexCredentialRecord | null,
) {
  if (!stored && !external) {
    return null;
  }
  if (!stored && external) {
    return {
      ...external,
      updatedAt: Date.now(),
    };
  }
  if (stored && !external) {
    // External Codex login state is the source of truth for identity. If the
    // CLI login disappears, do not silently keep using an older cached token.
    return null;
  }
  if (!stored || !external) {
    return null;
  }

  if (
    external.sourceFingerprint != null &&
    external.sourceFingerprint !== stored.sourceFingerprint
  ) {
    // A changed external credential means the user likely re-authenticated,
    // switched account, or changed workspace. Prefer the current external login
    // even if its expiry is earlier than our cached token.
    return {
      ...external,
      updatedAt: Date.now(),
    };
  }

  if (stored.expiresAt >= external.expiresAt) {
    return stored;
  }

  return {
    ...external,
    updatedAt: Date.now(),
  };
}

function shouldPersistMergedCredential(
  stored: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    accountId?: string;
    sourceFingerprint?: string;
    updatedAt: number;
  } | null,
  merged: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    accountId?: string;
    sourceFingerprint?: string;
    updatedAt: number;
  } | null,
): boolean {
  if (!merged) {
    return false;
  }
  if (!stored) {
    return true;
  }
  return (
    stored.accessToken !== merged.accessToken ||
    stored.refreshToken !== merged.refreshToken ||
    stored.expiresAt !== merged.expiresAt ||
    stored.accountId !== merged.accountId ||
    stored.sourceFingerprint !== merged.sourceFingerprint
  );
}

async function persistCredential(credential: {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountId?: string;
  sourceFingerprint?: string;
  updatedAt: number;
}) {
  const sourceFingerprint =
    credential.sourceFingerprint ?? readCodexSourceFingerprint() ?? undefined;
  await writeStoredCodexCredential({
    ...credential,
    ...(sourceFingerprint == null ? {} : { sourceFingerprint }),
  });
}
