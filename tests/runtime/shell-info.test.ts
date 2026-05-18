import { describe, expect, test } from "vitest";

import { detectRuntimeShellInfo, getDefaultBashExecutable } from "@/src/runtime/shell-info.js";

describe("runtime shell info", () => {
  test("detects Git Bash on native Windows from MSYSTEM", () => {
    const info = detectRuntimeShellInfo({
      platform: "win32",
      env: {
        MSYSTEM: "MINGW64",
        SHELL: "C:/Program Files/Git/usr/bin/bash.exe",
      },
    });

    expect(info.platformLabel).toBe("Windows");
    expect(info.hostShell.kind).toBe("git_bash");
    expect(info.hostShell.label).toBe("Git Bash / MinGW (MINGW64)");
    expect(info.bashTool).toMatchObject({
      executable: "bash",
      invocation: "bash -lc <command>",
      syntax: "bash",
      defaultSandboxMode: "sandboxed",
    });
    expect(info.notes.join("\n")).toContain("native Windows process");
  });

  test("detects Command Prompt on native Windows from PROMPT and ComSpec", () => {
    const info = detectRuntimeShellInfo({
      platform: "win32",
      env: {
        PROMPT: "$P$G",
        ComSpec: "C:\\Windows\\System32\\cmd.exe",
      },
    });

    expect(info.hostShell.kind).toBe("cmd");
    expect(info.hostShell.label).toBe("Command Prompt");
    expect(info.hostShell.executable).toBe("C:\\Windows\\System32\\cmd.exe");
  });

  test("keeps unknown Windows shell explicit when env cannot identify it", () => {
    const info = detectRuntimeShellInfo({
      platform: "win32",
      env: {},
    });

    expect(info.hostShell.kind).toBe("unknown_windows");
    expect(info.notes.join("\n")).toContain("not identifiable");
    expect(info.notes.join("\n")).toContain("does not grant full_access");
  });

  test("uses /bin/bash on non-Windows platforms without Windows shell notes", () => {
    const info = detectRuntimeShellInfo({
      platform: "linux",
      env: {
        SHELL: "/bin/zsh",
      },
    });

    expect(getDefaultBashExecutable("linux")).toBe("/bin/bash");
    expect(info.platformLabel).toBe("Linux");
    expect(info.hostShell.kind).toBe("unknown");
    expect(info.hostShell.label).toBe("/bin/zsh");
    expect(info.bashTool.invocation).toBe("/bin/bash -lc <command>");
    expect(info.notes).toEqual(["The bash tool uses bash syntax through /bin/bash -lc."]);
  });
});
