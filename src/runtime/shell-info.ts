export type RuntimeShellKind =
  | "bash"
  | "git_bash"
  | "msys_bash"
  | "cygwin_bash"
  | "cmd"
  | "powershell"
  | "unknown_windows"
  | "unknown";

export interface RuntimeShellEndpoint {
  kind: RuntimeShellKind;
  label: string;
  executable: string | null;
  detectionSource: string;
}

export interface RuntimeShellInfo {
  platform: NodeJS.Platform;
  platformLabel: string;
  isWindows: boolean;
  hostShell: RuntimeShellEndpoint;
  bashTool: {
    executable: string;
    invocation: string;
    syntax: "bash";
    defaultSandboxMode: "sandboxed";
  };
  notes: string[];
}

export function getDefaultBashExecutable(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "bash" : "/bin/bash";
}

export function detectRuntimeShellInfo(
  input: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {},
): RuntimeShellInfo {
  const platform = input.platform ?? process.platform;
  const env = input.env ?? process.env;
  const bashExecutable = getDefaultBashExecutable(platform);
  const hostShell = detectHostShell({ platform, env });

  return {
    platform,
    platformLabel: formatPlatformLabel(platform),
    isWindows: platform === "win32",
    hostShell,
    bashTool: {
      executable: bashExecutable,
      invocation: `${bashExecutable} -lc <command>`,
      syntax: "bash",
      defaultSandboxMode: "sandboxed",
    },
    notes: buildShellNotes({ platform, hostShell }),
  };
}

function detectHostShell(input: {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
}): RuntimeShellEndpoint {
  if (input.platform === "win32") {
    return detectWindowsHostShell(input.env);
  }

  const shell = getEnv(input.env, "SHELL");
  if (shell != null) {
    return {
      kind: basename(shell).includes("bash") ? "bash" : "unknown",
      label: shell,
      executable: shell,
      detectionSource: "SHELL",
    };
  }

  return {
    kind: "unknown",
    label: "Unknown host shell",
    executable: null,
    detectionSource: "process.platform",
  };
}

function detectWindowsHostShell(env: NodeJS.ProcessEnv): RuntimeShellEndpoint {
  const msystem = getEnv(env, "MSYSTEM")?.toUpperCase();
  const ostype = getEnv(env, "OSTYPE")?.toLowerCase();
  const shell = getEnv(env, "SHELL");
  const normalizedShell = shell == null ? null : normalizeSlashes(shell).toLowerCase();

  if (msystem != null && msystem.length > 0) {
    if (msystem.startsWith("MINGW")) {
      return {
        kind: "git_bash",
        label: `Git Bash / MinGW (${msystem})`,
        executable: shell ?? "bash",
        detectionSource: "MSYSTEM",
      };
    }
    if (msystem === "MSYS") {
      return {
        kind: "msys_bash",
        label: "MSYS Bash",
        executable: shell ?? "bash",
        detectionSource: "MSYSTEM",
      };
    }
  }

  if (ostype?.includes("cygwin") === true || normalizedShell?.includes("cygwin") === true) {
    return {
      kind: "cygwin_bash",
      label: "Cygwin Bash",
      executable: shell ?? "bash",
      detectionSource: ostype?.includes("cygwin") === true ? "OSTYPE" : "SHELL",
    };
  }

  if (normalizedShell != null && basename(normalizedShell).includes("bash")) {
    return {
      kind: "bash",
      label: shell ?? "bash",
      executable: shell ?? "bash",
      detectionSource: "SHELL",
    };
  }

  const prompt = getEnv(env, "PROMPT");
  const comspec = getEnv(env, "ComSpec") ?? getEnv(env, "COMSPEC");
  if (prompt != null && comspec != null && basename(comspec).toLowerCase() === "cmd.exe") {
    return {
      kind: "cmd",
      label: "Command Prompt",
      executable: comspec,
      detectionSource: "PROMPT/ComSpec",
    };
  }

  const powershellHost = getEnv(env, "POWERSHELL_DISTRIBUTION_CHANNEL");
  if (powershellHost != null) {
    return {
      kind: "powershell",
      label: "PowerShell",
      executable: "pwsh",
      detectionSource: "POWERSHELL_DISTRIBUTION_CHANNEL",
    };
  }

  return {
    kind: "unknown_windows",
    label: "Unknown Windows host shell",
    executable: null,
    detectionSource: "process.platform",
  };
}

function buildShellNotes(input: {
  platform: NodeJS.Platform;
  hostShell: RuntimeShellEndpoint;
}): string[] {
  if (input.platform !== "win32") {
    return ["The bash tool uses bash syntax through /bin/bash -lc."];
  }

  return [
    "This is a native Windows process.",
    "The bash tool still expects bash syntax and invokes bash -lc; PowerShell and cmd syntax are not interchangeable with bash tool commands.",
    "This runtime context is informational only. It does not grant full_access host execution or bypass approvals.",
    ...(input.hostShell.kind === "unknown_windows"
      ? ["The exact Windows parent shell was not identifiable from the process environment."]
      : []),
  ];
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

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, "/");
}

function basename(value: string): string {
  const normalized = normalizeSlashes(value);
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}
