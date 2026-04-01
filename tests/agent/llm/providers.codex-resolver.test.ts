import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ResolvedProvider } from "@/src/agent/llm/models.js";
import { CodexProviderApiKeyResolver } from "@/src/agent/llm/providers/codex/resolver.js";

const { readLocalCodexCredentialMock, readCodexSourceFingerprintMock } = vi.hoisted(() => ({
  readLocalCodexCredentialMock: vi.fn(),
  readCodexSourceFingerprintMock: vi.fn(),
}));
const { readStoredCodexCredentialMock, writeStoredCodexCredentialMock } = vi.hoisted(() => ({
  readStoredCodexCredentialMock: vi.fn(),
  writeStoredCodexCredentialMock: vi.fn(),
}));
const { refreshOpenAICodexTokenMock } = vi.hoisted(() => ({
  refreshOpenAICodexTokenMock: vi.fn(),
}));
const { withFileLockMock } = vi.hoisted(() => ({
  withFileLockMock: vi.fn(async (_targetPath: string, fn: () => Promise<unknown>) => await fn()),
}));

vi.mock("@/src/agent/llm/providers/codex/local-auth.js", () => ({
  readLocalCodexCredential: readLocalCodexCredentialMock,
  readCodexSourceFingerprint: readCodexSourceFingerprintMock,
}));
vi.mock("@/src/agent/llm/providers/codex/store.js", () => ({
  readStoredCodexCredential: readStoredCodexCredentialMock,
  writeStoredCodexCredential: writeStoredCodexCredentialMock,
}));
vi.mock("@mariozechner/pi-ai/oauth", () => ({
  refreshOpenAICodexToken: refreshOpenAICodexTokenMock,
}));
vi.mock("@/src/shared/file-lock.js", () => ({
  withFileLock: withFileLockMock,
}));

describe("codex provider api key resolver", () => {
  beforeEach(() => {
    readLocalCodexCredentialMock.mockReset();
    readCodexSourceFingerprintMock.mockReset();
    readStoredCodexCredentialMock.mockReset();
    writeStoredCodexCredentialMock.mockReset();
    refreshOpenAICodexTokenMock.mockReset();
    withFileLockMock.mockClear();
    readCodexSourceFingerprintMock.mockReturnValue("fingerprint:1");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("returns configured api key for non-codex providers", async () => {
    const resolver = new CodexProviderApiKeyResolver();
    const provider: ResolvedProvider = {
      id: "anthropic_main",
      api: "anthropic-messages",
      apiKey: "secret",
    };

    await expect(resolver.resolveApiKey(provider)).resolves.toBe("secret");
    expect(readStoredCodexCredentialMock).not.toHaveBeenCalled();
  });

  test("rejects codex-local on non-codex provider apis", async () => {
    const resolver = new CodexProviderApiKeyResolver();
    const provider: ResolvedProvider = {
      id: "bad_provider",
      api: "anthropic-messages",
      authSource: "codex-local",
    };

    await expect(resolver.resolveApiKey(provider)).rejects.toThrow(
      'Provider "bad_provider" cannot use authSource = "codex-local" unless api = "openai-codex-responses"',
    );
  });

  test("imports external local codex credential when store is empty", async () => {
    const resolver = new CodexProviderApiKeyResolver();
    readStoredCodexCredentialMock.mockResolvedValue(null);
    readLocalCodexCredentialMock.mockReturnValue({
      accessToken: "external-access",
      refreshToken: "external-refresh",
      expiresAt: Date.now() + 60_000,
      accountId: "acct_1",
      sourceFingerprint: "fingerprint:1",
    });

    const provider: ResolvedProvider = {
      id: "openai_codex",
      api: "openai-codex-responses",
      authSource: "codex-local",
    };

    await expect(resolver.resolveApiKey(provider)).resolves.toBe("external-access");
    expect(writeStoredCodexCredentialMock).toHaveBeenCalledOnce();
  });

  test("preserves keychain fingerprint when persisting imported credentials", async () => {
    const resolver = new CodexProviderApiKeyResolver();
    readStoredCodexCredentialMock.mockResolvedValue(null);
    readCodexSourceFingerprintMock.mockReturnValue(null);
    readLocalCodexCredentialMock.mockReturnValue({
      accessToken: "external-access",
      refreshToken: "external-refresh",
      expiresAt: Date.now() + 60_000,
      accountId: "acct_1",
      sourceFingerprint: "keychain:cli|abcd1234",
    });

    const provider: ResolvedProvider = {
      id: "openai_codex",
      api: "openai-codex-responses",
      authSource: "codex-local",
    };

    await expect(resolver.resolveApiKey(provider)).resolves.toBe("external-access");
    expect(writeStoredCodexCredentialMock).toHaveBeenCalledWith(
      expect.objectContaining({ sourceFingerprint: "keychain:cli|abcd1234" }),
    );
  });

  test("prefers the current external Codex login even when its expiry is earlier", async () => {
    const resolver = new CodexProviderApiKeyResolver();
    readStoredCodexCredentialMock.mockResolvedValue({
      accessToken: "stored-access",
      refreshToken: "stored-refresh",
      expiresAt: Date.now() + 60_000,
      accountId: "acct_old",
      updatedAt: Date.now() - 2_000,
      sourceFingerprint: "fingerprint:1",
    });
    readLocalCodexCredentialMock.mockReturnValue({
      accessToken: "external-access",
      refreshToken: "external-refresh",
      expiresAt: Date.now() + 1_000,
      accountId: "acct_new",
      sourceFingerprint: "fingerprint:2",
    });

    const provider: ResolvedProvider = {
      id: "openai_codex",
      api: "openai-codex-responses",
      authSource: "codex-local",
    };

    await expect(resolver.resolveApiKey(provider)).resolves.toBe("external-access");
    expect(writeStoredCodexCredentialMock).toHaveBeenCalledOnce();
  });

  test("treats missing external Codex login as unavailable instead of silently reusing stale store", async () => {
    const resolver = new CodexProviderApiKeyResolver();
    readStoredCodexCredentialMock.mockResolvedValue({
      accessToken: "stored-access",
      refreshToken: "stored-refresh",
      expiresAt: Date.now() + 60_000,
      accountId: "acct_old",
      updatedAt: Date.now() - 2_000,
      sourceFingerprint: "fingerprint:1",
    });
    readLocalCodexCredentialMock.mockReturnValue(null);

    const provider: ResolvedProvider = {
      id: "openai_codex",
      api: "openai-codex-responses",
      authSource: "codex-local",
    };

    await expect(resolver.resolveApiKey(provider)).resolves.toBeUndefined();
  });

  test("refreshes expired stored credential when external source is not newer", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-31T12:00:00.000Z"));

    const resolver = new CodexProviderApiKeyResolver();
    readStoredCodexCredentialMock.mockResolvedValue({
      accessToken: "stored-access",
      refreshToken: "stored-refresh",
      expiresAt: Date.now() - 1_000,
      updatedAt: Date.now() - 2_000,
      sourceFingerprint: "fingerprint:1",
    });
    readLocalCodexCredentialMock.mockReturnValue({
      accessToken: "external-access",
      refreshToken: "external-refresh",
      expiresAt: Date.now() - 5_000,
      sourceFingerprint: "fingerprint:1",
    });
    refreshOpenAICodexTokenMock.mockResolvedValue({
      access: "refreshed-access",
      refresh: "refreshed-refresh",
      expires: Date.now() + 60_000,
      accountId: "acct_2",
    });

    const provider: ResolvedProvider = {
      id: "openai_codex",
      api: "openai-codex-responses",
      authSource: "codex-local",
    };

    await expect(resolver.resolveApiKey(provider)).resolves.toBe("refreshed-access");
    expect(withFileLockMock).toHaveBeenCalledOnce();
    expect(refreshOpenAICodexTokenMock).toHaveBeenCalledWith("stored-refresh");
    expect(writeStoredCodexCredentialMock).toHaveBeenCalled();
  });
});
