import { describe, expect, test } from "vitest";

import { classifyBashApprovalHelper } from "@/src/security/bash-approval-helpers.js";
import {
  type BashCommandSegment,
  parseConservativeBashCommandSequence,
} from "@/src/security/bash-prefix.js";

describe("classifyBashApprovalHelper", () => {
  test("allows echo helpers only for literal output markers", () => {
    for (const command of ["echo", "echo foo", "echo '--- status ---'", "echo ==== done ===="]) {
      expect(classifyOnlySegment(command)).toBe("standalone");
    }
  });

  test("rejects echo helpers with shell-expanded argument shapes", () => {
    for (const command of [
      "echo *",
      "echo file?.txt",
      "echo [abc]",
      "echo ~",
      "echo ~/workspace",
      "echo {a,b}",
    ]) {
      expect(classifyOnlySegment(command)).toBeNull();
    }
  });

  test("allows jq stdin selectors that preserve the common JSON inspection workflow", () => {
    for (const command of [
      "near view contract method '{}' | jq .result",
      "near view contract method '{}' | jq -r .result",
      "near view contract method '{}' | jq '.result[]'",
      "near view contract method '{}' | jq '.result.items[0].name'",
      "near view contract method '{}' | jq '.[\"result-key\"]'",
      "near view contract method '{}' | jq '.result.items[:10]'",
      "near view contract method '{}' | jq '.result.items[-3:]'",
      "near view contract method '{}' | jq '.optional?[]? | .name?'",
      "near view contract method '{}' | jq '.result[] | .name'",
      "near view contract method '{}' | jq '.[] | .id'",
    ]) {
      expect(classifyLastSegment(command)).toBe("pipeline");
    }
  });

  test("rejects jq filters with host-readable or general program capability", () => {
    for (const command of [
      "git pull | jq 'env.TEST_JQ_SECRET'",
      "git pull | jq '$ENV'",
      "git pull | jq 'import \"secrets\" as $s; .'",
      "git pull | jq 'include \"secrets\"; .'",
      "git pull | jq 'map(select(.x == 1))'",
      "git pull | jq '.result | select(.enabled)'",
      "git pull | jq '.result | length'",
      "git pull | jq '.result, .other'",
      "git pull | jq '.items[:]'",
    ]) {
      expect(classifyLastSegment(command)).toBeNull();
    }
  });

  test("allows quiet head and tail helpers that still only consume stdin", () => {
    for (const command of [
      "git log --oneline | tail -q -n 5",
      "git log --oneline | tail --quiet -n 5",
      "git log --oneline | tail --silent -n 5",
      "git log --oneline | tail -qn 5",
      "git log --oneline | tail -q5",
      "git log --oneline | head --quiet -n 5",
    ]) {
      expect(classifyLastSegment(command)).toBe("pipeline");
    }
  });
});

function classifyLastSegment(command: string) {
  return classifyBashApprovalHelper(lastSegment(command));
}

function classifyOnlySegment(command: string) {
  const sequence = parseConservativeBashCommandSequence(command);
  if (sequence == null) {
    return null;
  }

  const segment = sequence?.commands[0];
  if (sequence.commands.length !== 1 || segment == null) {
    throw new Error(`Expected exactly one parsed command: ${command}`);
  }
  return classifyBashApprovalHelper(segment);
}

function lastSegment(command: string): BashCommandSegment {
  const sequence = parseConservativeBashCommandSequence(command);
  const segment = sequence?.commands.at(-1);
  if (segment == null) {
    throw new Error(`Expected command to parse: ${command}`);
  }
  return segment;
}
