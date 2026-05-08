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

const HEAD_TAIL_QUIET_OPTIONS = new Set(["-q", "--quiet", "--silent"]);

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
  return segment.argv.slice(1).every(isLiteralEchoArgument);
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

    if (HEAD_TAIL_QUIET_OPTIONS.has(arg)) {
      continue;
    }

    if (arg === "-qn" || arg === "-qc") {
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
      /^-q(?:[0-9]+|[nc][0-9]+)$/.test(arg) ||
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
      if (!isSafeJqPathFilter(arg)) {
        return false;
      }
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

  return filterSeen;
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

function isLiteralEchoArgument(arg: string): boolean {
  return !(arg.startsWith("~") || /[*?[\]{}]/.test(arg) || /^[!@+]\(/.test(arg));
}

// jq helper mode intentionally accepts selectors, not jq programs. That keeps
// common JSON inspection useful while rejecting host-readable features such as
// env/$ENV, import/include, rawfile/slurpfile, and arbitrary builtin calls.
function isSafeJqPathFilter(filter: string): boolean {
  const stages = splitJqSelectorPipeline(filter.trim());
  return stages != null && stages.length > 0 && stages.every(isSafeJqSelectorStage);
}

function splitJqSelectorPipeline(filter: string): string[] | null {
  if (filter.length === 0) {
    return null;
  }

  const stages: string[] = [];
  let stageStart = 0;
  let inString = false;
  let escaping = false;

  for (let index = 0; index < filter.length; index += 1) {
    const char = filter[index];

    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }
      if (char === "\\") {
        escaping = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "|") {
      const stage = filter.slice(stageStart, index).trim();
      if (stage.length === 0) {
        return null;
      }
      stages.push(stage);
      stageStart = index + 1;
    }
  }

  if (inString || escaping) {
    return null;
  }

  const finalStage = filter.slice(stageStart).trim();
  if (finalStage.length === 0) {
    return null;
  }
  stages.push(finalStage);
  return stages;
}

function isSafeJqSelectorStage(stage: string): boolean {
  if (stage === ".") {
    return true;
  }
  if (!stage.startsWith(".")) {
    return false;
  }

  let index = 1;
  if (index >= stage.length) {
    return true;
  }

  if (isJqIdentifierStart(stage[index])) {
    index = consumeJqIdentifier(stage, index);
    index = consumeOptionalJqMarker(stage, index);
  } else if (stage[index] === "[") {
    const nextIndex = consumeJqBracketSelector(stage, index);
    if (nextIndex == null) {
      return false;
    }
    index = consumeOptionalJqMarker(stage, nextIndex);
  } else {
    return false;
  }

  while (index < stage.length) {
    if (stage[index] === ".") {
      index += 1;
      if (!isJqIdentifierStart(stage[index])) {
        return false;
      }
      index = consumeJqIdentifier(stage, index);
      index = consumeOptionalJqMarker(stage, index);
      continue;
    }

    if (stage[index] === "[") {
      const nextIndex = consumeJqBracketSelector(stage, index);
      if (nextIndex == null) {
        return false;
      }
      index = consumeOptionalJqMarker(stage, nextIndex);
      continue;
    }

    return false;
  }

  return true;
}

function consumeJqBracketSelector(stage: string, startIndex: number): number | null {
  let inString = false;
  let escaping = false;

  for (let index = startIndex + 1; index < stage.length; index += 1) {
    const char = stage[index];
    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }
      if (char === "\\") {
        escaping = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char !== "]") {
      continue;
    }

    const content = stage.slice(startIndex + 1, index).trim();
    return isSafeJqBracketSelectorContent(content) ? index + 1 : null;
  }

  return null;
}

function isSafeJqBracketSelectorContent(content: string): boolean {
  if (content.length === 0) {
    return true;
  }
  if (/^-?[0-9]+$/.test(content)) {
    return true;
  }
  if (isSafeJqNumericSliceContent(content)) {
    return true;
  }

  try {
    return typeof JSON.parse(content) === "string";
  } catch {
    return false;
  }
}

function isSafeJqNumericSliceContent(content: string): boolean {
  const match = content.match(/^(-?[0-9]+)?:(-?[0-9]+)?$/);
  return match != null && (match[1] != null || match[2] != null);
}

function consumeJqIdentifier(stage: string, startIndex: number): number {
  let index = startIndex + 1;
  while (index < stage.length && isJqIdentifierPart(stage[index])) {
    index += 1;
  }
  return index;
}

function consumeOptionalJqMarker(stage: string, index: number): number {
  return stage[index] === "?" ? index + 1 : index;
}

function isJqIdentifierStart(char: string | undefined): boolean {
  return char != null && /^[A-Za-z_]$/.test(char);
}

function isJqIdentifierPart(char: string | undefined): boolean {
  return char != null && /^[A-Za-z0-9_]$/.test(char);
}
