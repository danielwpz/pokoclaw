export interface SimpleBashCommand {
  envAssignments: string[];
  argv: string[];
}

const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=.*$/;
const UNSUPPORTED_UNQUOTED_CHARS = new Set([
  "|",
  "&",
  ";",
  "(",
  ")",
  "<",
  ">",
  "\n",
  "\r",
  "`",
  "$",
]);

// This parser is intentionally conservative. It only recognizes a single
// literal shell command with optional leading KEY=value assignments. Anything
// more complex falls back to one-shot approval rather than guessing.
export function parseSimpleBashCommand(command: string): SimpleBashCommand | null {
  const tokens = tokenizeLiteralShellWords(command);
  if (tokens == null || tokens.length === 0) {
    return null;
  }

  const envAssignments: string[] = [];
  let argvStart = 0;

  while (argvStart < tokens.length && ENV_ASSIGNMENT_RE.test(tokens[argvStart] ?? "")) {
    envAssignments.push(tokens[argvStart] as string);
    argvStart += 1;
  }

  const argv = tokens.slice(argvStart);
  if (argv.length === 0) {
    return null;
  }

  return {
    envAssignments,
    argv,
  };
}

export function normalizeBashCommandPrefix(command: string): string[] | null {
  return parseSimpleBashCommand(command)?.argv ?? null;
}

export function bashPrefixMatchesCommand(prefix: string[], commandArgv: string[]): boolean {
  if (prefix.length === 0 || prefix.length > commandArgv.length) {
    return false;
  }

  for (let index = 0; index < prefix.length; index += 1) {
    if (prefix[index] !== commandArgv[index]) {
      return false;
    }
  }

  return true;
}

function tokenizeLiteralShellWords(command: string): string[] | null {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  const pushCurrent = () => {
    if (current.length === 0) {
      return;
    }
    tokens.push(current);
    current = "";
  };

  for (const char of command) {
    if (quote === "'") {
      if (char === "'") {
        quote = null;
        continue;
      }

      current += char;
      continue;
    }

    if (quote === '"') {
      if (escaping) {
        current += char;
        escaping = false;
        continue;
      }

      if (char === "\\") {
        escaping = true;
        continue;
      }

      if (char === '"') {
        quote = null;
        continue;
      }

      if (char === "$" || char === "`") {
        return null;
      }

      current += char;
      continue;
    }

    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\") {
      escaping = true;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (char.trim().length === 0) {
      pushCurrent();
      continue;
    }

    if (UNSUPPORTED_UNQUOTED_CHARS.has(char) || char === "#") {
      return null;
    }

    current += char;
  }

  if (quote != null || escaping) {
    return null;
  }

  pushCurrent();
  return tokens;
}
