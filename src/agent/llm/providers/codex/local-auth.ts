import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface CodexCredentialRecord {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountId?: string;
  sourceFingerprint?: string;
}

const CODEX_AUTH_FILENAME = "auth.json";

export function readLocalCodexCredential(): CodexCredentialRecord | null {
  return readCodexKeychainCredential() ?? readCodexFileCredential();
}

export function resolveCodexAuthPath(): string {
  return path.join(resolveCodexHomePath(), CODEX_AUTH_FILENAME);
}

export function readCodexSourceFingerprint(): string | null {
  const authPath = resolveCodexAuthPath();
  try {
    const stat = fs.statSync(authPath);
    return `${authPath}:${stat.mtimeMs}`;
  } catch {
    return null;
  }
}

function resolveCodexHomePath(): string {
  const configured = process.env.CODEX_HOME;
  const home = configured ? resolveUserPath(configured) : resolveUserPath("~/.codex");
  try {
    return fs.realpathSync.native(home);
  } catch {
    return home;
  }
}

function resolveUserPath(input: string): string {
  if (input === "~") {
    return process.env.HOME ?? input;
  }
  if (input.startsWith("~/")) {
    return path.join(process.env.HOME ?? "~", input.slice(2));
  }
  return input;
}

function computeCodexKeychainAccount(codexHome: string): string {
  const hash = createHash("sha256").update(codexHome).digest("hex");
  return `cli|${hash.slice(0, 16)}`;
}

function readCodexKeychainCredential(): CodexCredentialRecord | null {
  if (process.platform !== "darwin") {
    return null;
  }

  const codexHome = resolveCodexHomePath();
  const account = computeCodexKeychainAccount(codexHome);

  try {
    const secret = execSync(`security find-generic-password -s "Codex Auth" -a "${account}" -w`, {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    const parsed = JSON.parse(secret) as Record<string, unknown>;
    return parseCodexAuthJson(parsed, `keychain:${account}`);
  } catch {
    return null;
  }
}

function readCodexFileCredential(): CodexCredentialRecord | null {
  const authPath = resolveCodexAuthPath();
  try {
    const raw = fs.readFileSync(authPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parseCodexAuthJson(parsed, readCodexSourceFingerprint() ?? authPath);
  } catch {
    return null;
  }
}

function parseCodexAuthJson(
  data: Record<string, unknown>,
  sourceFingerprint: string,
): CodexCredentialRecord | null {
  const tokens = data.tokens as Record<string, unknown> | undefined;
  const accessToken = tokens?.access_token;
  const refreshToken = tokens?.refresh_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    return null;
  }
  if (typeof refreshToken !== "string" || refreshToken.length === 0) {
    return null;
  }

  const expiresAt = decodeJwtExpiryMs(accessToken) ?? Date.now() + 60 * 60 * 1000;
  const accountId = typeof tokens?.account_id === "string" ? tokens.account_id : undefined;

  return {
    accessToken,
    refreshToken,
    expiresAt,
    ...(accountId == null ? {} : { accountId }),
    sourceFingerprint,
  };
}

function decodeJwtExpiryMs(token: string): number | null {
  const parts = token.split(".");
  if (parts.length < 2) {
    return null;
  }
  try {
    const payloadRaw = Buffer.from(parts[1] ?? "", "base64url").toString("utf8");
    const payload = JSON.parse(payloadRaw) as { exp?: unknown };
    return typeof payload.exp === "number" && Number.isFinite(payload.exp) && payload.exp > 0
      ? payload.exp * 1000
      : null;
  } catch {
    return null;
  }
}
