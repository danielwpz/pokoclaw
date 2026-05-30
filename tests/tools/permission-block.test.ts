import { describe, expect, test } from "vitest";

import { expandPermissionEntriesToScopes } from "@/src/tools/helpers/permission-block.js";

describe("permission block helpers", () => {
  test("expands subtree entries with the stable filesystem subtree suffix", () => {
    expect(
      expandPermissionEntriesToScopes([
        {
          resource: "filesystem",
          path: "C:\\Users\\example\\project",
          scope: "subtree",
          access: "read_write",
        },
      ]),
    ).toEqual([
      { kind: "fs.read", path: "C:\\Users\\example\\project/**" },
      { kind: "fs.write", path: "C:\\Users\\example\\project/**" },
    ]);
  });
});
