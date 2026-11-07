#!/usr/bin/env node
// Blocks commits that would publish secrets or personal data.
//
//   node scripts/privacy-check.mjs        scan lines added in the staged diff (pre-commit)
//   node scripts/privacy-check.mjs --all  scan every tracked file (CI)
//
// Personal strings that must never appear (server IPs, account IDs, names) go in a local
// denylist that is never committed: one literal per line, `#` for comments, matched
// case-insensitively. A `!literal` line is an exception that is ignored when matching, e.g.
// `alice` plus `!alice-oss` for a public handle. Default location is
// `.git/info/privacy-denylist`; override with POKOCLAW_PRIVACY_DENYLIST. A line containing
// `privacy-check: allow` is skipped.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const ALLOW_MARKER = "privacy-check: allow";
const SKIP_FILES = new Set(["pnpm-lock.yaml"]);
const PLACEHOLDER_USERS = new Set([
  "example",
  "user",
  "username",
  "me",
  "you",
  "test",
  "tester",
  "dev",
  "demo",
  "foo",
  "name",
  "someone",
  "alice",
  "bob",
  "runner",
  "ubuntu",
  "shared",
]);

const RULES = [
  { name: "private-key", pattern: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/g },
  {
    name: "api-token",
    pattern:
      /\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{40,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35})/g,
  },
  {
    name: "home-path",
    pattern: /(?:\/Users\/|\/home\/|[A-Za-z]:\\{1,2}Users\\{1,2})([A-Za-z0-9._-]+)/g,
    keep: (match) => !PLACEHOLDER_USERS.has(match[1].toLowerCase()),
  },
  { name: "lark-id", pattern: /\b(?:(?:ou|oc|on|om)_[0-9a-f]{32}|cli_[0-9a-f]{16})\b/g },
  {
    name: "lark-doc-link",
    pattern:
      /(?:feishu\.cn|larksuite\.com|larkoffice\.com)\/(?:docx|docs|wiki|sheets|base|file|mindnotes|slides)\/[A-Za-z0-9]{20,}/g,
  },
  {
    name: "personal-email",
    pattern:
      /[A-Za-z0-9._%+-]+@(?:gmail|qq|163|126|outlook|hotmail|icloud|yahoo|foxmail|proton(?:mail)?)\.(?:com|me)\b/gi,
  },
  {
    name: "public-ipv4",
    pattern: /(?<![\d.v])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\d.])/g,
    keep: (match) => isPublicIpv4(match.slice(1, 5).map(Number)),
  },
];

function isPublicIpv4([a, b, c, d]) {
  if ([a, b, c, d].some((part) => part > 255)) return false;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  if (a === 1 && b === 1 && c === 1 && d === 1) return false;
  if (a === 8 && b === 8 && (c === 8 || c === 4) && (d === 8 || d === 4)) return false;
  return true;
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

function loadDenylist() {
  const path =
    process.env.POKOCLAW_PRIVACY_DENYLIST ||
    git(["rev-parse", "--git-path", "info/privacy-denylist"]).trim();
  if (!existsSync(path)) return { entries: [], exceptions: [] };
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim().toLowerCase())
    .filter((line) => line && !line.startsWith("#"));
  return {
    entries: lines.filter((line) => !line.startsWith("!")),
    exceptions: lines
      .filter((line) => line.startsWith("!") && line.length > 1)
      .map((line) => line.slice(1)),
  };
}

function* stagedLines() {
  const diff = git([
    "diff",
    "--cached",
    "-U0",
    "--no-color",
    "--no-ext-diff",
    "--diff-filter=ACMR",
  ]);
  let file = null;
  let lineNo = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      file = line === "+++ /dev/null" ? null : line.slice(6);
    } else if (line.startsWith("@@")) {
      lineNo = Number(/\+(\d+)/.exec(line)?.[1] ?? 0);
    } else if (file && line.startsWith("+")) {
      yield { file, lineNo, text: line.slice(1) };
      lineNo += 1;
    }
  }
}

function* trackedLines() {
  for (const file of git(["ls-files", "-z"]).split("\0")) {
    if (!file || !existsSync(file)) continue;
    const content = readFileSync(file);
    if (content.includes(0)) continue;
    const lines = content.toString("utf8").split("\n");
    for (let i = 0; i < lines.length; i += 1) yield { file, lineNo: i + 1, text: lines[i] };
  }
}

function mask(value) {
  return value.length <= 12 ? value : `${value.slice(0, 8)}…${value.slice(-4)}`;
}

const denylist = loadDenylist();
const findings = [];
const lines = process.argv.includes("--all") ? trackedLines() : stagedLines();

for (const { file, lineNo, text } of lines) {
  if (SKIP_FILES.has(file.split("/").pop()) || text.includes(ALLOW_MARKER)) continue;
  for (const rule of RULES) {
    for (const match of text.matchAll(rule.pattern)) {
      if (!rule.keep || rule.keep(match)) {
        findings.push(`${file}:${lineNo}  ${rule.name}  ${mask(match[0])}`);
      }
    }
  }
  const lower = denylist.exceptions.reduce(
    (line, exception) => line.replaceAll(exception, " "),
    text.toLowerCase(),
  );
  denylist.entries.forEach((entry, index) => {
    if (lower.includes(entry)) findings.push(`${file}:${lineNo}  local-denylist #${index + 1}`);
  });
}

if (findings.length > 0) {
  console.error("[privacy-check] possible secrets or personal data:");
  for (const finding of findings) console.error(`  ${finding}`);
  console.error(
    `[privacy-check] replace them with placeholders, or add "${ALLOW_MARKER}" to a line that is a false positive.`,
  );
  process.exit(1);
}
