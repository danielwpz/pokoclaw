import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CODEX_CREDENTIALS_PATH } from "@/src/shared/paths.js";

export interface StoredCodexCredential {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountId?: string;
  sourceFingerprint?: string;
  updatedAt: number;
}

export async function readStoredCodexCredential(): Promise<StoredCodexCredential | null> {
  try {
    const raw = await readFile(CODEX_CREDENTIALS_PATH, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.accessToken !== "string" || typeof parsed.refreshToken !== "string") {
      return null;
    }
    if (typeof parsed.expiresAt !== "number" || !Number.isFinite(parsed.expiresAt)) {
      return null;
    }
    if (typeof parsed.updatedAt !== "number" || !Number.isFinite(parsed.updatedAt)) {
      return null;
    }

    return {
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken,
      expiresAt: parsed.expiresAt,
      updatedAt: parsed.updatedAt,
      ...(typeof parsed.accountId === "string" ? { accountId: parsed.accountId } : {}),
      ...(typeof parsed.sourceFingerprint === "string"
        ? { sourceFingerprint: parsed.sourceFingerprint }
        : {}),
    };
  } catch {
    return null;
  }
}

export async function writeStoredCodexCredential(credential: StoredCodexCredential): Promise<void> {
  await mkdir(path.dirname(CODEX_CREDENTIALS_PATH), { recursive: true, mode: 0o700 });
  await writeFile(CODEX_CREDENTIALS_PATH, `${JSON.stringify(credential, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}
