import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  buildEffectivePermissions,
  checkDatabasePermission,
  checkFilesystemPermission,
  parseGrantedScopes,
} from "@/src/security/permissions.js";
import { DEFAULT_SYSTEM_POLICY } from "@/src/security/policy.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "pokeclaw-permissions-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("effective permissions", () => {
  test("builds fs and db permissions from granted scopes", () => {
    const permissions = buildEffectivePermissions([
      { kind: "fs.read", path: "/Users/daniel/.pokeclaw/workspace/**" },
      { kind: "fs.write", path: "/Users/daniel/project/README.md" },
      { kind: "db.read", database: "system" },
    ]);

    expect(permissions.fs.read.allow).toContain(
      `${path.resolve("/Users/daniel/.pokeclaw/workspace")}/**`,
    );
    expect(permissions.fs.write.allow).toContain(path.resolve("/Users/daniel/project/README.md"));
    expect(permissions.db.read).toBe(true);
    expect(permissions.db.write).toBe(false);
  });

  test("parses granted scopes from stored JSON", () => {
    expect(
      parseGrantedScopes([
        '{"kind":"fs.read","path":"/Users/daniel/.pokeclaw/workspace/**"}',
        '{"kind":"db.read","database":"system"}',
      ]),
    ).toEqual([
      { kind: "fs.read", path: "/Users/daniel/.pokeclaw/workspace/**" },
      { kind: "db.read", database: "system" },
    ]);
  });

  test("merges multiple grants of the same kind", () => {
    const permissions = buildEffectivePermissions([
      { kind: "fs.read", path: "/Users/daniel/project-a/**" },
      { kind: "fs.read", path: "/Users/daniel/project-b/**" },
      { kind: "db.read", database: "system" },
      { kind: "db.write", database: "system" },
    ]);

    expect(permissions.fs.read.allow).toEqual([
      `${path.resolve("/Users/daniel/project-a")}/**`,
      `${path.resolve("/Users/daniel/project-b")}/**`,
    ]);
    expect(permissions.db.read).toBe(true);
    expect(permissions.db.write).toBe(true);
  });
});

describe("filesystem permission checks", () => {
  test("allows granted subtree reads", () => {
    const permissions = buildEffectivePermissions([
      { kind: "fs.read", path: "/Users/daniel/.pokeclaw/workspace/**" },
    ]);

    expect(
      checkFilesystemPermission({
        kind: "fs.read",
        targetPath: "/Users/daniel/.pokeclaw/workspace/memory/state.json",
        permissions,
      }),
    ).toEqual({
      result: "allow",
      reason: "granted",
      summary: "fs.read is granted for /Users/daniel/.pokeclaw/workspace/memory/state.json",
    });
  });

  test("blocks hard denied system paths even without considering grants", () => {
    const permissions = buildEffectivePermissions([
      { kind: "fs.read", path: "/Users/daniel/.pokeclaw/workspace/**" },
    ]);

    expect(
      checkFilesystemPermission({
        kind: "fs.read",
        targetPath: path.join(os.homedir(), ".pokeclaw", "system", "config.toml"),
        permissions,
      }),
    ).toEqual({
      result: "deny",
      reason: "hard_deny",
      summary: `fs.read is blocked by system policy for ${path.join(os.homedir(), ".pokeclaw", "system", "config.toml")}`,
    });
  });

  test("requires approval when path is not granted", () => {
    const permissions = buildEffectivePermissions([]);

    expect(
      checkFilesystemPermission({
        kind: "fs.write",
        targetPath: "/Users/daniel/project/README.md",
        permissions,
      }),
    ).toEqual({
      result: "deny",
      reason: "not_granted",
      summary: "fs.write requires approval for /Users/daniel/project/README.md",
    });
  });

  test("allows exact-path writes only for the exact file", () => {
    const permissions = buildEffectivePermissions([
      { kind: "fs.write", path: "/Users/daniel/project/README.md" },
    ]);

    expect(
      checkFilesystemPermission({
        kind: "fs.write",
        targetPath: "/Users/daniel/project/README.md",
        permissions,
      }),
    ).toEqual({
      result: "allow",
      reason: "granted",
      summary: "fs.write is granted for /Users/daniel/project/README.md",
    });

    expect(
      checkFilesystemPermission({
        kind: "fs.write",
        targetPath: "/Users/daniel/project/README.md.bak",
        permissions,
      }),
    ).toEqual({
      result: "deny",
      reason: "not_granted",
      summary: "fs.write requires approval for /Users/daniel/project/README.md.bak",
    });
  });

  test("does not let subtree grants leak into sibling paths", () => {
    const permissions = buildEffectivePermissions([
      { kind: "fs.read", path: "/Users/daniel/project/**" },
    ]);

    expect(
      checkFilesystemPermission({
        kind: "fs.read",
        targetPath: "/Users/daniel/project-file/notes.txt",
        permissions,
      }),
    ).toEqual({
      result: "deny",
      reason: "not_granted",
      summary: "fs.read requires approval for /Users/daniel/project-file/notes.txt",
    });
  });

  test("normalizes relative runtime paths against cwd before checking", async () => {
    const permissions = buildEffectivePermissions([
      { kind: "fs.read", path: `${tempDir}/workspace/**` },
    ]);
    await mkdir(path.join(tempDir, "workspace"), { recursive: true });
    const realWorkspaceDir = await realpath(path.join(tempDir, "workspace"));
    const expectedPath = path.join(realWorkspaceDir, "notes", "today.md");

    expect(
      checkFilesystemPermission({
        kind: "fs.read",
        targetPath: "./notes/today.md",
        cwd: path.join(tempDir, "workspace"),
        permissions,
      }),
    ).toEqual({
      result: "allow",
      reason: "granted",
      summary: `fs.read is granted for ${expectedPath}`,
    });
  });

  test("respects read allow-back inside denied regions", () => {
    const permissions = buildEffectivePermissions(
      [{ kind: "fs.read", path: "/Users/daniel/project/safe/**" }],
      {
        ...DEFAULT_SYSTEM_POLICY,
        fs: {
          ...DEFAULT_SYSTEM_POLICY.fs,
          read: {
            ...DEFAULT_SYSTEM_POLICY.fs.read,
            deny: ["/Users/daniel/project/**"],
          },
        },
      },
    );

    expect(
      checkFilesystemPermission({
        kind: "fs.read",
        targetPath: "/Users/daniel/project/safe/README.md",
        permissions,
      }),
    ).toEqual({
      result: "allow",
      reason: "granted",
      summary: "Read access granted for /Users/daniel/project/safe/README.md",
    });
  });

  test("keeps write deny precedence over allow", () => {
    const permissions = buildEffectivePermissions(
      [{ kind: "fs.write", path: "/Users/daniel/project/**" }],
      {
        ...DEFAULT_SYSTEM_POLICY,
        fs: {
          ...DEFAULT_SYSTEM_POLICY.fs,
          write: {
            ...DEFAULT_SYSTEM_POLICY.fs.write,
            deny: ["/Users/daniel/project/blocked/**"],
          },
        },
      },
    );

    expect(
      checkFilesystemPermission({
        kind: "fs.write",
        targetPath: "/Users/daniel/project/blocked/data.json",
        permissions,
      }),
    ).toEqual({
      result: "deny",
      reason: "not_granted",
      summary: "fs.write is not granted for /Users/daniel/project/blocked/data.json",
    });
  });

  test("expands home-prefixed policy paths", () => {
    const permissions = buildEffectivePermissions([{ kind: "fs.read", path: "~/allowed/**" }]);
    const homeDir = os.homedir();

    expect(permissions.fs.read.allow).toContain(`${path.join(homeDir, "allowed")}/**`);
  });

  test("resolves symlinked target paths before subtree checks", async () => {
    const outsideDir = path.join(tempDir, "outside");
    const workspaceDir = path.join(tempDir, "workspace");
    const linkDir = path.join(workspaceDir, "linked");
    await mkdir(outsideDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(path.join(outsideDir, "secret.txt"), "secret", "utf8");
    await symlink(outsideDir, linkDir, "dir");
    const realOutsideDir = await realpath(outsideDir);

    const permissions = buildEffectivePermissions([
      { kind: "fs.read", path: `${workspaceDir}/**` },
    ]);

    expect(
      checkFilesystemPermission({
        kind: "fs.read",
        targetPath: path.join(linkDir, "secret.txt"),
        permissions,
      }),
    ).toEqual({
      result: "deny",
      reason: "not_granted",
      summary: `fs.read requires approval for ${path.join(realOutsideDir, "secret.txt")}`,
    });
  });

  test("normalizes non-existing paths through the nearest existing symlink ancestor", async () => {
    const outsideDir = path.join(tempDir, "outside");
    const workspaceDir = path.join(tempDir, "workspace");
    const linkDir = path.join(workspaceDir, "linked");
    await mkdir(outsideDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });
    await symlink(outsideDir, linkDir, "dir");
    const realOutsideDir = await realpath(outsideDir);

    const permissions = buildEffectivePermissions([
      { kind: "fs.write", path: `${workspaceDir}/**` },
    ]);

    expect(
      checkFilesystemPermission({
        kind: "fs.write",
        targetPath: path.join(linkDir, "new.txt"),
        permissions,
      }),
    ).toEqual({
      result: "deny",
      reason: "not_granted",
      summary: `fs.write requires approval for ${path.join(realOutsideDir, "new.txt")}`,
    });
  });
});

describe("database permission checks", () => {
  test("allows granted db read access", () => {
    const permissions = buildEffectivePermissions([{ kind: "db.read", database: "system" }]);

    expect(
      checkDatabasePermission({
        kind: "db.read",
        permissions,
      }),
    ).toEqual({
      result: "allow",
      reason: "granted",
      summary: "db.read is granted for the system database",
    });
  });

  test("requires approval when db access is not granted", () => {
    const permissions = buildEffectivePermissions([]);

    expect(
      checkDatabasePermission({
        kind: "db.write",
        permissions,
      }),
    ).toEqual({
      result: "deny",
      reason: "not_granted",
      summary: "db.write requires approval for the system database",
    });
  });

  test("respects global db policy disablement", () => {
    const permissions = buildEffectivePermissions([{ kind: "db.read", database: "system" }], {
      ...DEFAULT_SYSTEM_POLICY,
      db: {
        read: false,
        write: false,
      },
    });

    expect(
      checkDatabasePermission({
        kind: "db.read",
        permissions,
      }),
    ).toEqual({
      result: "deny",
      reason: "not_granted",
      summary: "db.read requires approval for the system database",
    });
  });
});
