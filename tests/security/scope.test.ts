import { describe, expect, test } from "vitest";

import {
  describePermissionRequest,
  describePermissionScope,
  isFsSubtreeScopePath,
  parsePermissionRequestJson,
  parsePermissionScopeJson,
  serializePermissionRequest,
  serializePermissionScope,
} from "@/src/security/scope.js";

describe("permission scope parsing", () => {
  test("parses fs exact path scopes", () => {
    expect(
      parsePermissionScopeJson('{"kind":"fs.read","path":"/Users/example/project/README.md"}'),
    ).toEqual({
      kind: "fs.read",
      path: "/Users/example/project/README.md",
    });
  });

  test("parses fs subtree scopes", () => {
    expect(
      parsePermissionScopeJson(
        '{"kind":"fs.write","path":"/Users/example/.pokoclaw/workspace/**"}',
      ),
    ).toEqual({
      kind: "fs.write",
      path: "/Users/example/.pokoclaw/workspace/**",
    });
    expect(isFsSubtreeScopePath("/Users/example/.pokoclaw/workspace/**")).toBe(true);
  });

  test("parses db scopes", () => {
    expect(parsePermissionScopeJson('{"kind":"db.read","database":"system"}')).toEqual({
      kind: "db.read",
      database: "system",
    });
  });

  test("rejects relative fs paths", () => {
    expect(() =>
      parsePermissionScopeJson('{"kind":"fs.read","path":"workspace/file.txt"}'),
    ).toThrow("Invalid permission scope JSON: fs.read path must be an absolute path");
  });

  test("rejects filesystem root subtree scopes", () => {
    expect(() => parsePermissionScopeJson('{"kind":"fs.read","path":"/**"}')).toThrow(
      "Invalid permission scope JSON: fs.read path must not target the filesystem root subtree",
    );
  });

  test("rejects unsupported globs", () => {
    expect(() =>
      parsePermissionScopeJson('{"kind":"fs.read","path":"/Users/example/project/*.ts"}'),
    ).toThrow(
      "Invalid permission scope JSON: fs.read path only supports exact absolute paths or paths ending with /**",
    );
  });

  test("rejects wildcard characters outside trailing subtree suffix", () => {
    expect(() =>
      parsePermissionScopeJson('{"kind":"fs.write","path":"/Users/example/*/build.log"}'),
    ).toThrow(
      "Invalid permission scope JSON: fs.write path only supports exact absolute paths or paths ending with /**",
    );
  });

  test("rejects unsupported db targets", () => {
    expect(() => parsePermissionScopeJson('{"kind":"db.write","database":"analytics"}')).toThrow(
      'Invalid permission scope JSON: db.write database must be "system"',
    );
  });
});

describe("permission request parsing", () => {
  test("parses requests with multiple scopes", () => {
    expect(
      parsePermissionRequestJson(
        '{"scopes":[{"kind":"fs.write","path":"/Users/example/.pokoclaw/workspace/**"},{"kind":"db.read","database":"system"}]}',
      ),
    ).toEqual({
      scopes: [
        {
          kind: "fs.write",
          path: "/Users/example/.pokoclaw/workspace/**",
        },
        {
          kind: "db.read",
          database: "system",
        },
      ],
    });
  });

  test("rejects empty scope arrays", () => {
    expect(() => parsePermissionRequestJson('{"scopes":[]}')).toThrow(
      "Invalid permission request JSON: permission request scopes must be a non-empty array",
    );
  });

  test("points at the invalid nested scope when request parsing fails", () => {
    expect(() =>
      parsePermissionRequestJson(
        '{"scopes":[{"kind":"fs.read","path":"workspace/file.txt"},{"kind":"db.read","database":"system"}]}',
      ),
    ).toThrow(
      "Invalid permission request JSON: permission request scopes[0]: fs.read path must be an absolute path",
    );
  });
});

describe("permission scope serialization", () => {
  test("serializes scopes and requests", () => {
    expect(
      serializePermissionScope({
        kind: "fs.read",
        path: "/Users/example/project/README.md",
      }),
    ).toBe('{"kind":"fs.read","path":"/Users/example/project/README.md"}');

    expect(
      serializePermissionRequest({
        scopes: [{ kind: "db.read", database: "system" }],
      }),
    ).toBe('{"scopes":[{"kind":"db.read","database":"system"}]}');
  });

  test("describes scopes in human-friendly text", () => {
    expect(
      describePermissionScope({
        kind: "fs.write",
        path: "/Users/example/.pokoclaw/workspace/**",
      }),
    ).toBe("Write /Users/example/.pokoclaw/workspace/**");
    expect(
      describePermissionScope({
        kind: "db.read",
        database: "system",
      }),
    ).toBe("Read system database");
  });

  test("describes permission requests with every requested scope", () => {
    expect(
      describePermissionRequest({
        scopes: [
          {
            kind: "fs.read",
            path: "/Users/example/project/README.md",
          },
          {
            kind: "fs.write",
            path: "/Users/example/project/output.txt",
          },
          {
            kind: "db.read",
            database: "system",
          },
        ],
      }),
    ).toBe(
      "Read /Users/example/project/README.md; Write /Users/example/project/output.txt; Read system database",
    );
  });

  test("detects non-subtree filesystem paths correctly", () => {
    expect(isFsSubtreeScopePath("/Users/example/project/README.md")).toBe(false);
  });
});
