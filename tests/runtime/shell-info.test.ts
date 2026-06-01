import { describe, expect, test } from "vitest";

import { detectRuntimeShellInfo, getDefaultBashExecutable } from "@/src/runtime/shell-info.js";

describe("runtime shell info", () => {
  test("keeps non-Windows platforms on bash syntax", () => {
    const info = detectRuntimeShellInfo({
      platform: "linux",
      env: {
        SHELL: "/bin/zsh",
      },
    });

    expect(getDefaultBashExecutable("linux")).toBe("/bin/bash");
    expect(info).toMatchObject({
      platformLabel: "Linux",
      isWindows: false,
      commandShell: {
        kind: "bash",
        label: "bash",
        executable: "/bin/bash",
        args: ["-lc"],
        invocation: "/bin/bash -lc <command>",
        syntax: "bash",
        recommended: true,
      },
    });
  });

  test("prefers PowerShell 7 on native Windows", () => {
    const info = detectRuntimeShellInfo({
      platform: "win32",
      env: {
        ProgramFiles: "C:\\Program Files",
        SystemRoot: "C:\\Windows",
      },
      isExecutableAvailable: (candidate) =>
        candidate === "C:\\Program Files\\PowerShell\\7\\pwsh.exe" || candidate === "cmd.exe",
    });

    expect(info).toMatchObject({
      platformLabel: "Windows",
      isWindows: true,
      commandShell: {
        kind: "powershell",
        label: "PowerShell 7",
        executable: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
        args: ["-NoProfile", "-NonInteractive", "-Command"],
        invocation:
          "C:\\Program Files\\PowerShell\\7\\pwsh.exe -NoProfile -NonInteractive -Command <command>",
        syntax: "powershell",
        recommended: true,
      },
    });
  });

  test("falls back to Windows PowerShell when pwsh is unavailable", () => {
    const info = detectRuntimeShellInfo({
      platform: "win32",
      env: {
        ProgramFiles: "C:\\Program Files",
        SystemRoot: "C:\\Windows",
      },
      isExecutableAvailable: (candidate) =>
        candidate === "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    });

    expect(info.commandShell).toMatchObject({
      kind: "powershell",
      label: "PowerShell",
      executable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      syntax: "powershell",
      recommended: true,
    });
  });

  test("falls back to cmd only when PowerShell is unavailable", () => {
    const info = detectRuntimeShellInfo({
      platform: "win32",
      env: {
        ComSpec: "C:\\Windows\\System32\\cmd.exe",
      },
      isExecutableAvailable: (candidate) => candidate === "C:\\Windows\\System32\\cmd.exe",
    });

    expect(info.commandShell).toMatchObject({
      kind: "cmd",
      label: "cmd",
      executable: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c"],
      invocation: "C:\\Windows\\System32\\cmd.exe /d /s /c <command>",
      syntax: "cmd",
      recommended: false,
    });
  });
});
