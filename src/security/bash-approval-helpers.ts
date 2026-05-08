import type { BashCommandSegment } from "@/src/security/bash-prefix.js";

const JQ_FORBIDDEN_OPTIONS = new Set([
  "-f",
  "--from-file",
  "-L",
  "--rawfile",
  "--slurpfile",
  "--argfile",
]);

const JQ_ALLOWED_FLAG_OPTIONS = new Set([
  "-r",
  "--raw-output",
  "-c",
  "--compact-output",
  "-M",
  "--monochrome-output",
  "-S",
  "--sort-keys",
  "-e",
  "--exit-status",
  "-s",
  "--slurp",
  "-R",
  "--raw-input",
  "-j",
  "--join-output",
  "--tab",
  "--ascii-output",
  "-a",
]);

const JQ_ALLOWED_VALUE_OPTIONS = new Map<string, number>([
  ["--arg", 2],
  ["--argjson", 2],
  ["--indent", 1],
]);

const WC_ALLOWED_LONG_OPTIONS = new Set([
  "--bytes",
  "--chars",
  "--lines",
  "--max-line-length",
  "--words",
]);

export type BashApprovalHelperKind = "standalone" | "pipeline";

export function classifyBashApprovalHelper(
  segment: BashCommandSegment,
): BashApprovalHelperKind | null {
  const commandName = segment.argv[0];
  if (commandName == null || hasExecutionContext(segment)) {
    return null;
  }

  switch (commandName) {
    case "echo":
      return isLiteralEcho(segment) ? "standalone" : null;
    case "head":
      return isStdinHeadOrTail(segment) ? "pipeline" : null;
    case "tail":
      return isStdinHeadOrTail(segment) ? "pipeline" : null;
    case "wc":
      return isStdinWc(segment) ? "pipeline" : null;
    case "jq":
      return isStdinJq(segment) ? "pipeline" : null;
    default:
      return null;
  }
}

function hasExecutionContext(segment: BashCommandSegment): boolean {
  return segment.envAssignments.length > 0 || segment.redirects.length > 0;
}

function isLiteralEcho(segment: BashCommandSegment): boolean {
  return segment.argv.length >= 1;
}

function isStdinHeadOrTail(segment: BashCommandSegment): boolean {
  if (!segment.stdinFromPipe) {
    return false;
  }

  for (let index = 1; index < segment.argv.length; index += 1) {
    const arg = segment.argv[index];
    if (arg == null) {
      return false;
    }

    if (arg === "-n" || arg === "-c") {
      const value = segment.argv[index + 1];
      if (value == null || !isCountValue(value)) {
        return false;
      }
      index += 1;
      continue;
    }

    if (
      /^-[0-9]+$/.test(arg) ||
      /^-[nc][0-9]+$/.test(arg) ||
      /^--(?:lines|bytes)=\+?[0-9]+$/.test(arg)
    ) {
      continue;
    }

    return false;
  }

  return true;
}

function isStdinWc(segment: BashCommandSegment): boolean {
  if (!segment.stdinFromPipe) {
    return false;
  }

  for (let index = 1; index < segment.argv.length; index += 1) {
    const arg = segment.argv[index];
    if (arg == null) {
      return false;
    }

    if (WC_ALLOWED_LONG_OPTIONS.has(arg) || /^-[clLmw]+$/.test(arg)) {
      continue;
    }

    return false;
  }

  return true;
}

function isStdinJq(segment: BashCommandSegment): boolean {
  if (!segment.stdinFromPipe) {
    return false;
  }

  let filterSeen = false;
  let endOfOptions = false;
  for (let index = 1; index < segment.argv.length; index += 1) {
    const arg = segment.argv[index];
    if (arg == null) {
      return false;
    }

    if (filterSeen) {
      return false;
    }

    if (endOfOptions || !arg.startsWith("-") || arg === "-") {
      filterSeen = true;
      continue;
    }

    if (arg === "--") {
      endOfOptions = true;
      continue;
    }

    if (isForbiddenJqOption(arg)) {
      return false;
    }

    const valueOptionArity = JQ_ALLOWED_VALUE_OPTIONS.get(arg);
    if (valueOptionArity != null) {
      if (index + valueOptionArity >= segment.argv.length) {
        return false;
      }
      index += valueOptionArity;
      continue;
    }

    if (JQ_ALLOWED_FLAG_OPTIONS.has(arg) || isAllowedJqShortFlagCluster(arg)) {
      continue;
    }

    return false;
  }

  return true;
}

function isForbiddenJqOption(arg: string): boolean {
  if (JQ_FORBIDDEN_OPTIONS.has(arg)) {
    return true;
  }

  return (
    arg.startsWith("--rawfile=") ||
    arg.startsWith("--slurpfile=") ||
    arg.startsWith("--argfile=") ||
    arg.startsWith("--from-file=")
  );
}

function isAllowedJqShortFlagCluster(arg: string): boolean {
  if (!arg.startsWith("-") || arg.startsWith("--") || arg.length < 2) {
    return false;
  }

  const flags = arg.slice(1);
  if (flags.includes("f") || flags.includes("L")) {
    return false;
  }

  return /^[rcMSeRsRja]+$/.test(flags);
}

function isCountValue(value: string): boolean {
  return /^\+?[0-9]+$/.test(value);
}
