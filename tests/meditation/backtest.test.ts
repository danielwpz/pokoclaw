import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  buildDefaultMeditationBacktestSandboxPaths,
  buildMeditationBacktestRunRequest,
  buildMeditationBacktestSecurityConfig,
  buildMeditationBacktestWindow,
  prepareMeditationBacktestSandbox,
  sanitizeMeditationBacktestLabel,
} from "@/src/meditation/backtest.js";

describe("meditation backtest helpers", () => {
  test("builds an explicit backtest window when start and end are provided", () => {
    const window = buildMeditationBacktestWindow({
      tickAt: new Date("2026-04-15T12:30:00.000Z"),
      startAt: new Date("2026-04-14T00:00:00.000Z"),
      endAt: new Date("2026-04-15T00:00:00.000Z"),
      calendarContext: {
        currentDate: "2026-04-15",
        timezone: "Asia/Shanghai",
      },
    });

    expect(window).toEqual({
      startAt: "2026-04-14T00:00:00.000Z",
      endAt: "2026-04-15T00:00:00.000Z",
      lastSuccessAt: null,
      localDate: "2026-04-15",
      timezone: "Asia/Shanghai",
      clippedByLookback: false,
    });
  });

  test("builds a lookback-based request when explicit start is omitted", () => {
    const request = buildMeditationBacktestRunRequest({
      tickAt: new Date("2026-04-15T12:30:00.000Z"),
      lookbackDays: 2,
      calendarContext: {
        currentDate: "2026-04-15",
        timezone: "UTC",
      },
    });

    expect(request.tickAt.toISOString()).toBe("2026-04-15T12:30:00.000Z");
    expect(request.windowOverride).toMatchObject({
      startAt: "2026-04-13T12:30:00.000Z",
      endAt: "2026-04-15T12:30:00.000Z",
      localDate: "2026-04-15",
      timezone: "UTC",
      clippedByLookback: true,
    });
  });

  test("builds sandbox paths under repo tmp space", () => {
    const paths = buildDefaultMeditationBacktestSandboxPaths({
      label: "manual-run",
      cwd: "/repo/pokoclaw",
    });

    expect(paths).toEqual({
      rootDir: "/repo/pokoclaw/.tmp/meditation-backtests/manual-run",
      workspaceDir: "/repo/pokoclaw/.tmp/meditation-backtests/manual-run/workspace",
      logsDir: "/repo/pokoclaw/.tmp/meditation-backtests/manual-run/logs",
      databasePath: "/repo/pokoclaw/.tmp/meditation-backtests/manual-run/pokoclaw.db",
    });
  });

  test("hard-denies live and source data paths for backtest isolation", () => {
    const config = buildMeditationBacktestSecurityConfig({
      securityConfig: {
        filesystem: {
          overrideHardDenyRead: false,
          overrideHardDenyWrite: false,
          hardDenyRead: ["/already/denied"],
          hardDenyWrite: ["/already/denied-write"],
        },
        network: {
          overrideHardDenyHosts: false,
          hardDenyHosts: ["example.com"],
        },
      },
      sourceWorkspaceDir: "/live/workspace",
      sourceLogsDir: "/live/logs",
      sourceDatabasePath: "/live/system/pokoclaw.db",
    });

    expect(config.filesystem.hardDenyRead).toEqual(
      expect.arrayContaining([
        "/already/denied",
        "/live/workspace",
        "/live/workspace/**",
        "/live/logs",
        "/live/logs/**",
        "/live/system",
        "/live/system/**",
        "/live/system/pokoclaw.db",
      ]),
    );
    expect(config.filesystem.hardDenyWrite).toEqual(
      expect.arrayContaining([
        "/already/denied-write",
        "/live/workspace",
        "/live/workspace/**",
        "/live/logs",
        "/live/logs/**",
        "/live/system",
        "/live/system/**",
        "/live/system/pokoclaw.db",
      ]),
    );
    expect(config.network.hardDenyHosts).toEqual(["example.com"]);
  });

  test("prepare sandbox copies subagent memories but ignores non-directory entries", async ({
    task,
  }) => {
    const rootDir = `/tmp/${task.id}`;
    const sourceWorkspaceDir = path.join(rootDir, "source-workspace");
    const sourceSubagentsDir = path.join(sourceWorkspaceDir, "subagents");
    const sourceAgentDir = path.join(sourceSubagentsDir, "agent-a");
    const sandbox = buildDefaultMeditationBacktestSandboxPaths({
      label: "sandbox",
      cwd: rootDir,
    });
    const sourceDatabasePath = path.join(rootDir, "source.db");

    await mkdir(sourceAgentDir, { recursive: true });
    await writeFile(path.join(sourceWorkspaceDir, "MEMORY.md"), "# shared\n", "utf8");
    await writeFile(path.join(sourceAgentDir, "MEMORY.md"), "# private\n", "utf8");
    await writeFile(path.join(sourceSubagentsDir, ".DS_Store"), "junk", "utf8");
    await writeFile(sourceDatabasePath, "", "utf8");

    await prepareMeditationBacktestSandbox({
      sandbox,
      sourceWorkspaceDir,
      sourceDatabasePath,
    });

    await expect(readFile(path.join(sandbox.workspaceDir, "MEMORY.md"), "utf8")).resolves.toBe(
      "# shared\n",
    );
    await expect(
      readFile(path.join(sandbox.workspaceDir, "subagents", "agent-a", "MEMORY.md"), "utf8"),
    ).resolves.toBe("# private\n");
    await expect(
      readFile(path.join(sandbox.workspaceDir, "subagents", ".DS_Store", "MEMORY.md"), "utf8"),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("sanitizes labels for filesystem safety", () => {
    expect(sanitizeMeditationBacktestLabel("  2026/04/15 12:30:00 + weird  ")).toBe(
      "2026-04-15-12-30-00-weird",
    );
  });
});
