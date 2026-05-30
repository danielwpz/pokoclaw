export function isNativeWindowsPlatform(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32";
}

export function assertNativeWindowsRuntimeSupported(input: {
  autopilotEnabled: boolean;
  platform?: NodeJS.Platform;
}): void {
  if (!isNativeWindowsPlatform(input.platform) || input.autopilotEnabled) {
    return;
  }

  throw new Error(
    "Native Windows requires `[runtime] autopilot = true` in ~/.pokoclaw/system/config.toml. With this opt-in, bash commands run on the Windows host with full access instead of Linux sandbox isolation.",
  );
}

export function shouldInitializeSandboxRuntime(input: {
  autopilotEnabled: boolean;
  platform?: NodeJS.Platform;
}): boolean {
  return !(isNativeWindowsPlatform(input.platform) && input.autopilotEnabled);
}
