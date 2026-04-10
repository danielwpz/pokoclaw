import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  buildEffectivePermissions,
  buildEffectivePermissionsForRole,
  checkBashFullAccessPermission,
  checkDatabasePermission,
  checkFilesystemPermission,
  parseGrantedScopes,
} from "@/src/security/permissions.js";
import {
  buildAgentPermissionBaseline,
  buildSystemPolicy,
  DEFAULT_SYSTEM_POLICY,
} from "@/src/security/policy.js";
import {
  POKECLAW_LOGS_DIR,
  POKECLAW_REPO_DIR,
  POKECLAW_SKILLS_DIR,
  POKECLAW_WORKSPACE_DIR,
} from "@/src/shared/paths.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "pokeclaw-permissions-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("effective permissions", () => {
  test("parses granted scopes from stored JSON", () => {
    expect(
      parseGrantedScopes([
        '{"kind":"fs.read","path":"/Users/example/.pokeclaw/workspace/**"}',
        '{"kind":"db.read","database":"system"}',
        '{"kind":"bash.full_access","prefix":["git","push"]}',
      ]),
    ).toEqual([
      { kind: "fs.read", path: "/Users/example/.pokeclaw/workspace/**" },
      { kind: "db.read", database: "system" },
      { kind: "bash.full_access", prefix: ["git", "push"] },
    ]);
  });

  test("main agent baseline grants home read and workspace write", () => {
    const permissions = buildEffectivePermissions(
      [],
      buildSystemPolicy(),
      buildAgentPermissionBaseline("main"),
    );

    expect(permissions.fs.read.mode).toBe("allow_only");
    expect(permissions.fs.read.allow).toContain(`${path.resolve(os.homedir())}/**`);
    expect(permissions.fs.read.allow).toContain(`${path.resolve(POKECLAW_SKILLS_DIR)}/**`);
    expect(permissions.fs.read.allow).toContain(`${path.resolve(POKECLAW_REPO_DIR)}/**`);
    expect(permissions.fs.write.allow).toContain(`${path.resolve(POKECLAW_WORKSPACE_DIR)}/**`);
    expect(permissions.db.read).toBe(true);
    expect(permissions.db.write).toBe(false);
  });

  test("subagent baseline grants workspace, global skills, and pokeclaw repo read by default", () => {
    const permissions = buildEffectivePermissions(
      [],
      buildSystemPolicy(),
      buildAgentPermissionBaseline("subagent"),
    );

    expect(permissions.fs.read.mode).toBe("allow_only");
    expect(permissions.fs.read.allow).toEqual([
      `${path.resolve(POKECLAW_WORKSPACE_DIR)}/**`,
      `${path.resolve(POKECLAW_SKILLS_DIR)}/**`,
      `${path.resolve(POKECLAW_REPO_DIR)}/**`,
    ]);
    expect(permissions.fs.write.allow).toEqual([`${path.resolve(POKECLAW_WORKSPACE_DIR)}/**`]);
    expect(permissions.db.read).toBe(false);
    expect(permissions.db.write).toBe(false);
  });

  test("buildEffectivePermissionsForRole merges explicit grants with the role baseline", () => {
    const permissions = buildEffectivePermissionsForRole(
      [{ kind: "fs.write", path: "/Users/example/project/README.md" }],
      "subagent",
    );

    expect(permissions.fs.write.allow).toContain(path.resolve("/Users/example/project/README.md"));
    expect(permissions.fs.write.allow).toContain(`${path.resolve(POKECLAW_WORKSPACE_DIR)}/**`);
  });

  test("buildEffectivePermissions collects bash full-access prefixes from grants", () => {
    const permissions = buildEffectivePermissions(
      [{ kind: "bash.full_access", prefix: ["python", "-m", "agent_browser_cli"] }],
      buildSystemPolicy(),
      buildAgentPermissionBaseline("subagent"),
    );

    expect(permissions.bash.fullAccessPrefixes).toEqual([["python", "-m", "agent_browser_cli"]]);
  });
});

describe("filesystem permission checks", () => {
  test("main agent can read a normal home path without an explicit grant", () => {
    const permissions = buildEffectivePermissions(
      [],
      buildSystemPolicy(),
      buildAgentPermissionBaseline("main"),
    );

    expect(
      checkFilesystemPermission({
        kind: "fs.read",
        targetPath: path.join(os.homedir(), "Documents", "notes.md"),
        permissions,
      }),
    ).toEqual({
      result: "allow",
      reason: "granted",
      summary: `fs.read is granted for ${path.join(os.homedir(), "Documents", "notes.md")}`,
    });
  });

  test("main agent can read runtime logs through the existing home baseline", () => {
    const permissions = buildEffectivePermissions(
      [],
      buildSystemPolicy(),
      buildAgentPermissionBaseline("main"),
    );
    const targetPath = path.join(POKECLAW_LOGS_DIR, "runtime.log");

    expect(
      checkFilesystemPermission({
        kind: "fs.read",
        targetPath,
        permissions,
      }),
    ).toEqual({
      result: "allow",
      reason: "granted",
      summary: `fs.read is granted for ${targetPath}`,
    });
  });

  test("main agent still cannot write outside workspace without a grant", () => {
    const permissions = buildEffectivePermissions(
      [],
      buildSystemPolicy(),
      buildAgentPermissionBaseline("main"),
    );

    expect(
      checkFilesystemPermission({
        kind: "fs.write",
        targetPath: path.join(os.homedir(), "Documents", "notes.md"),
        permissions,
      }),
    ).toEqual({
      result: "deny",
      reason: "not_granted",
      summary: `fs.write requires approval for ${path.join(os.homedir(), "Documents", "notes.md")}`,
    });
  });

  test("subagent still requires approval to read unrelated paths outside the default allowlist", () => {
    const permissions = buildEffectivePermissions(
      [],
      buildSystemPolicy(),
      buildAgentPermissionBaseline("subagent"),
    );

    expect(
      checkFilesystemPermission({
        kind: "fs.read",
        targetPath: path.join(os.homedir(), "Documents", "notes.md"),
        permissions,
      }),
    ).toEqual({
      result: "deny",
      reason: "not_granted",
      summary: `fs.read requires approval for ${path.join(os.homedir(), "Documents", "notes.md")}`,
    });
  });

  test("subagent can read and write inside workspace by default", () => {
    const permissions = buildEffectivePermissions(
      [],
      buildSystemPolicy(),
      buildAgentPermissionBaseline("subagent"),
    );
    const workspaceFile = path.join(POKECLAW_WORKSPACE_DIR, "memory", "state.json");

    expect(
      checkFilesystemPermission({
        kind: "fs.read",
        targetPath: workspaceFile,
        permissions,
      }),
    ).toEqual({
      result: "allow",
      reason: "granted",
      summary: `fs.read is granted for ${workspaceFile}`,
    });

    expect(
      checkFilesystemPermission({
        kind: "fs.write",
        targetPath: workspaceFile,
        permissions,
      }),
    ).toEqual({
      result: "allow",
      reason: "granted",
      summary: `fs.write is granted for ${workspaceFile}`,
    });
  });

  test("hard denied system paths are always blocked", () => {
    const permissions = buildEffectivePermissions(
      [],
      buildSystemPolicy(),
      buildAgentPermissionBaseline("main"),
    );
    const targetPath = path.join(os.homedir(), ".pokeclaw", "system", "config.toml");

    expect(
      checkFilesystemPermission({
        kind: "fs.read",
        targetPath,
        permissions,
      }),
    ).toEqual({
      result: "deny",
      reason: "hard_deny",
      summary: `fs.read is blocked by system policy for ${targetPath}`,
    });
  });

  test("deny rules can carve out regions from allowed read paths", () => {
    const permissions = buildEffectivePermissions(
      [],
      {
        ...DEFAULT_SYSTEM_POLICY,
        fs: {
          ...DEFAULT_SYSTEM_POLICY.fs,
          read: {
            ...DEFAULT_SYSTEM_POLICY.fs.read,
            deny: ["/Users/example/project/**"],
          },
        },
      },
      buildAgentPermissionBaseline("main"),
    );

    expect(
      checkFilesystemPermission({
        kind: "fs.read",
        targetPath: "/Users/example/project/private.txt",
        permissions,
      }),
    ).toEqual({
      result: "deny",
      reason: "not_granted",
      summary: "fs.read requires approval for /Users/example/project/private.txt",
    });
  });

  test("subtree grants do not leak into sibling paths", () => {
    const permissions = buildEffectivePermissionsForRole(
      [{ kind: "fs.read", path: "/Users/example/project/**" }],
      "subagent",
    );

    expect(
      checkFilesystemPermission({
        kind: "fs.read",
        targetPath: "/Users/example/project-file/notes.txt",
        permissions,
      }),
    ).toEqual({
      result: "deny",
      reason: "not_granted",
      summary: "fs.read requires approval for /Users/example/project-file/notes.txt",
    });
  });

  test("normalizes relative runtime paths against cwd before checking", async () => {
    const workspaceDir = path.join(tempDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });
    const realWorkspaceDir = await realpath(workspaceDir);
    const expectedPath = path.join(realWorkspaceDir, "notes", "today.md");
    const permissions = buildEffectivePermissionsForRole(
      [{ kind: "fs.read", path: `${workspaceDir}/**` }],
      "subagent",
    );

    expect(
      checkFilesystemPermission({
        kind: "fs.read",
        targetPath: "./notes/today.md",
        cwd: workspaceDir,
        permissions,
      }),
    ).toEqual({
      result: "allow",
      reason: "granted",
      summary: `fs.read is granted for ${expectedPath}`,
    });
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

    const permissions = buildEffectivePermissionsForRole(
      [{ kind: "fs.read", path: `${workspaceDir}/**` }],
      "subagent",
    );

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

  test("exact directory read grants direct children but not deeper descendants", async () => {
    const parentDir = path.join(tempDir, "near-ai");
    const childDir = path.join(parentDir, "chat-api");
    const directFile = path.join(parentDir, "README.md");
    const nestedFile = path.join(childDir, "Cargo.toml");
    await mkdir(childDir, { recursive: true });
    await writeFile(directFile, "top", "utf8");
    await writeFile(nestedFile, "nested", "utf8");

    const permissions = buildEffectivePermissionsForRole(
      [{ kind: "fs.read", path: parentDir }],
      "subagent",
    );
    const normalizedDirectFile = await realpath(directFile);
    const normalizedChildDir = await realpath(childDir);
    const normalizedNestedFile = await realpath(nestedFile);

    expect(
      checkFilesystemPermission({
        kind: "fs.read",
        targetPath: directFile,
        permissions,
      }),
    ).toEqual({
      result: "allow",
      reason: "granted",
      summary: `fs.read is granted for ${normalizedDirectFile}`,
    });

    expect(
      checkFilesystemPermission({
        kind: "fs.read",
        targetPath: childDir,
        permissions,
      }),
    ).toEqual({
      result: "allow",
      reason: "granted",
      summary: `fs.read is granted for ${normalizedChildDir}`,
    });

    expect(
      checkFilesystemPermission({
        kind: "fs.read",
        targetPath: nestedFile,
        permissions,
      }),
    ).toEqual({
      result: "deny",
      reason: "not_granted",
      summary: `fs.read requires approval for ${normalizedNestedFile}`,
    });
  });
});

describe("bash full-access permission checks", () => {
  test("allows a command when its argv prefix matches an active grant", () => {
    const permissions = buildEffectivePermissions(
      [{ kind: "bash.full_access", prefix: ["git", "push"] }],
      buildSystemPolicy(),
      buildAgentPermissionBaseline("subagent"),
    );

    expect(
      checkBashFullAccessPermission({
        commandPrefix: ["git", "push", "origin", "main"],
        permissions,
      }),
    ).toEqual({
      result: "allow",
      reason: "granted",
      summary: "bash.full_access is granted for git push origin main",
    });
  });

  test("denies a command when no granted prefix matches", () => {
    const permissions = buildEffectivePermissions(
      [{ kind: "bash.full_access", prefix: ["git", "push"] }],
      buildSystemPolicy(),
      buildAgentPermissionBaseline("subagent"),
    );

    expect(
      checkBashFullAccessPermission({
        commandPrefix: ["git", "fetch", "origin"],
        permissions,
      }),
    ).toEqual({
      result: "deny",
      reason: "not_granted",
      summary: "bash.full_access requires approval for git fetch origin",
    });
  });
});

describe("database permission checks", () => {
  test("main agent can read the system database without an explicit grant", () => {
    const permissions = buildEffectivePermissionsForRole([], "main");

    expect(checkDatabasePermission({ kind: "db.read", permissions })).toEqual({
      result: "allow",
      reason: "granted",
      summary: "db.read is granted for the system database",
    });
  });

  test("allows granted db read access", () => {
    const permissions = buildEffectivePermissionsForRole(
      [{ kind: "db.read", database: "system" }],
      "subagent",
    );

    expect(checkDatabasePermission({ kind: "db.read", permissions })).toEqual({
      result: "allow",
      reason: "granted",
      summary: "db.read is granted for the system database",
    });
  });

  test("requires approval when db access is not granted", () => {
    const permissions = buildEffectivePermissionsForRole([], "subagent");

    expect(checkDatabasePermission({ kind: "db.write", permissions })).toEqual({
      result: "deny",
      reason: "not_granted",
      summary: "db.write requires approval for the system database",
    });
  });
});
