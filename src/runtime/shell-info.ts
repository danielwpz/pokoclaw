import { existsSync } from "node:fs";
import path from "node:path";

export type RuntimeShellKind = "bash" | "powershell" | "cmd";
export type RuntimeShellSyntax = "bash" | "powershell" | "cmd";

export interface RuntimeCommandShell {
  kind: RuntimeShellKind;
  label: string;
  executable: string;
  args: string[];
  invocation: string;
  syntax: RuntimeShellSyntax;
  recommended: boolean;
}

export interface RuntimeShellInfo {
  platform: NodeJS.Platform;
  platformLabel: string;
  isWindows: boolean;
  commandShell: RuntimeCommandShell;
}

export interface RuntimeShellDetectionInput {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  isExecutableAvailable?: (candidate: string) => boolean;
}

export function getDefaultBashExecutable(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "bash" : "/bin/bash";
}

export function detectRuntimeShellInfo(input: RuntimeShellDetectionInput = {}): RuntimeShellInfo {
  const platform = input.platform ?? process.platform;
  const env = input.env ?? process.env;
  const isExecutableAvailable =
    input.isExecutableAvailable ??
    ((candidate) => defaultIsExecutableAvailable(candidate, env, platform));
  const commandShell = resolveRuntimeCommandShell({ platform, env, isExecutableAvailable });

  return {
    platform,
    platformLabel: formatPlatformLabel(platform),
    isWindows: platform === "win32",
    commandShell,
  };
}

export function resolveRuntimeCommandShell(
  input: Required<Pick<RuntimeShellDetectionInput, "platform" | "env" | "isExecutableAvailable">>,
): RuntimeCommandShell {
  if (input.platform !== "win32") {
    const executable = getDefaultBashExecutable(input.platform);
    return {
      kind: "bash",
      label: "bash",
      executable,
      args: ["-lc"],
      invocation: `${executable} -lc <command>`,
      syntax: "bash",
      recommended: true,
    };
  }

  const powershell = resolveWindowsPowerShell(input);
  if (powershell != null) {
    return {
      kind: "powershell",
      label: powershell.label,
      executable: powershell.executable,
      args: ["-NoProfile", "-NonInteractive", "-Command"],
      invocation: `${powershell.executable} -NoProfile -NonInteractive -Command <command>`,
      syntax: "powershell",
      recommended: true,
    };
  }

  const cmd = resolveWindowsCmd(input);
  return {
    kind: "cmd",
    label: "cmd",
    executable: cmd,
    args: ["/d", "/s", "/c"],
    invocation: `${cmd} /d /s /c <command>`,
    syntax: "cmd",
    recommended: false,
  };
}

function resolveWindowsPowerShell(input: {
  env: NodeJS.ProcessEnv;
  isExecutableAvailable: (candidate: string) => boolean;
}): { executable: string; label: string } | null {
  const candidates = [
    ...windowsPowerShell7Candidates(input.env),
    "pwsh.exe",
    windowsPowerShell5Candidate(input.env),
    "powershell.exe",
  ].filter((candidate): candidate is string => candidate != null);

  for (const candidate of candidates) {
    if (input.isExecutableAvailable(candidate)) {
      return {
        executable: candidate,
        label: basename(candidate).toLowerCase().startsWith("pwsh") ? "PowerShell 7" : "PowerShell",
      };
    }
  }

  return null;
}

function resolveWindowsCmd(input: {
  env: NodeJS.ProcessEnv;
  isExecutableAvailable: (candidate: string) => boolean;
}): string {
  const candidates = [
    getEnv(input.env, "ComSpec"),
    getEnv(input.env, "COMSPEC"),
    windowsCmdCandidate(input.env),
    "cmd.exe",
  ].filter((candidate): candidate is string => candidate != null);

  return candidates.find((candidate) => input.isExecutableAvailable(candidate)) ?? "cmd.exe";
}

function windowsPowerShell7Candidates(env: NodeJS.ProcessEnv): string[] {
  return [
    getEnv(env, "ProgramFiles"),
    getEnv(env, "ProgramW6432"),
    getEnv(env, "ProgramFiles(x86)"),
  ]
    .filter((root): root is string => root != null)
    .map((root) => path.win32.join(root, "PowerShell", "7", "pwsh.exe"));
}

function windowsPowerShell5Candidate(env: NodeJS.ProcessEnv): string | null {
  const systemRoot = getEnv(env, "SystemRoot") ?? getEnv(env, "windir");
  return systemRoot == null
    ? null
    : path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function windowsCmdCandidate(env: NodeJS.ProcessEnv): string | null {
  const systemRoot = getEnv(env, "SystemRoot") ?? getEnv(env, "windir");
  return systemRoot == null ? null : path.win32.join(systemRoot, "System32", "cmd.exe");
}

function defaultIsExecutableAvailable(
  candidate: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): boolean {
  if (isAbsolutePath(candidate, platform)) {
    return existsSync(candidate);
  }

  return findExecutableInPath(candidate, env, platform) != null;
}

function findExecutableInPath(
  candidate: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string | null {
  const pathValue = getEnv(env, "PATH");
  if (pathValue == null) {
    return null;
  }

  const delimiter = platform === "win32" ? ";" : ":";
  const extensions =
    platform === "win32"
      ? (getEnv(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
      : [""];
  const candidateExt = path.extname(candidate);
  const names =
    platform === "win32" && candidateExt.length === 0
      ? extensions.map((extension) => `${candidate}${extension.toLowerCase()}`)
      : [candidate];

  for (const directory of pathValue.split(delimiter)) {
    if (directory.trim().length === 0) {
      continue;
    }

    for (const name of names) {
      const resolved =
        platform === "win32" ? path.win32.join(directory, name) : path.posix.join(directory, name);
      if (existsSync(resolved)) {
        return resolved;
      }
    }
  }

  return null;
}

function isAbsolutePath(value: string, platform: NodeJS.Platform): boolean {
  return platform === "win32" ? path.win32.isAbsolute(value) : path.posix.isAbsolute(value);
}

function formatPlatformLabel(platform: NodeJS.Platform): string {
  switch (platform) {
    case "win32":
      return "Windows";
    case "darwin":
      return "macOS";
    case "linux":
      return "Linux";
    default:
      return platform;
  }
}

function getEnv(env: NodeJS.ProcessEnv, name: string): string | null {
  const direct = env[name];
  if (direct != null && direct.trim().length > 0) {
    return sanitizeEnvText(direct);
  }

  const entry = Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase());
  const value = entry?.[1];
  return value == null || value.trim().length === 0 ? null : sanitizeEnvText(value);
}

function sanitizeEnvText(value: string): string {
  let sanitized = "";
  for (const char of value) {
    const codePoint = char.codePointAt(0);
    sanitized += codePoint == null || codePoint < 32 || codePoint === 127 ? " " : char;
  }

  return sanitized.replace(/\s+/g, " ").trim().slice(0, 160);
}

function basename(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}
