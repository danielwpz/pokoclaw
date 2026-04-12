import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

let tempDir: string;
let credentialPath: string;

vi.mock("@/src/shared/paths.js", () => ({
  get CODEX_CREDENTIALS_PATH() {
    return credentialPath;
  },
}));

describe("codex credential store", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokoclaw-codex-store-test-"));
    credentialPath = path.join(tempDir, "codex-credentials.json");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    vi.resetModules();
  });

  test("writes credentials with 0600 permissions", async () => {
    const { writeStoredCodexCredential } = await import("@/src/agent/llm/providers/codex/store.js");

    await writeStoredCodexCredential({
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: Date.now() + 60_000,
      updatedAt: Date.now(),
    });

    const mode = (await stat(credentialPath)).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(JSON.parse(await readFile(credentialPath, "utf8"))).toMatchObject({
      accessToken: "access",
      refreshToken: "refresh",
    });
  });
});
