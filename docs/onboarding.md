# Pokoclaw AI Onboarding Guide

Use this guide to take a user from a fresh clone to a running local Pokoclaw setup.

## Goal

Finish with a valid config under `~/.pokoclaw/system/`, including Feishu/Lark channel config, and a successful `pnpm start`.

## Rules

- This is an interactive setup assistant flow, not a heads-down autonomous migration agent.
- Move in visible phases. After each phase or meaningful setup step, send the user a short explicit update or confirmation before continuing.
- Treat user-facing progress updates as required behavior, not a nice-to-have.
- At minimum, give the user a short update when:
- you start onboarding
- you finish a named phase
- you are about to switch to the next phase
- you need the user to make a choice
- you hit a problem or something unclear
- Do not silently keep working for a long stretch if the phase boundary has changed or a user decision is needed.
- Example opening message: `I’ve read the onboarding guide. I’ll start with Phase 1: repository setup and environment checks.`
- Example phase handoff: `Phase 1 is complete. Next I’m checking whether an existing OpenClaw setup is present before choosing import or clean setup.`
- Example later handoff: `The LLM config step is complete. Next I’m moving to the required Feishu/Lark setup.`
- Assume the repo was freshly cloned.
- Always finish repository setup before configuration work.
- Detect existing OpenClaw config before starting clean setup.
- If OpenClaw is detected, summarize what looks importable and ask whether the user wants to import all, some, or none of it.
- This onboarding guide is already the main operating playbook. Unless the user asks for deeper investigation or something is unclear or broken, there is usually no need to inspect large parts of the codebase.
- Prefer following these docs over exploratory code reading. By default, do not read unrelated code during onboarding.
- Do not search unusual system credential stores or guess secret sources.
- Do not ask the user to paste secrets into chat by default.
- If file-based secrets are needed, write a `secrets.toml` skeleton with placeholders and ask the user to fill the real values.
- Only write real secrets into files if the user explicitly asks.
- Feishu/Lark is currently the only supported channel and is required before startup.
- Run Feishu/Lark as an independent required phase: `docs/feishu-lark-setup.md`, Phase 3C: Required Feishu/Lark setup.
- For Feishu/Lark, warn that current support is for one personal assistant, not a shared team bot.
- Ask early whether the user expects web search or web fetch. If yes, guide them to configure Tavily during onboarding.
- Tell the user Tavily can be registered with a free account at `https://www.tavily.com/`, then help them get an API key and wire it into Pokoclaw config.
- Explain the difference briefly:
- `web search` finds current information or relevant pages on the internet.
- `web fetch` opens a known page and reads its contents.
- Example: use `web search` to find an official docs page, then use `web fetch` to read and summarize it.
- During model choice, actively recommend a strong model. Best experience: GPT-5 or Claude Sonnet. Minimum acceptable floor: a strong mainstream model such as MiniMax 2.7 class.
- Do not present obviously weak models as a neutral default. Explain briefly that weak models often do not really save tokens or time; they mostly buy more retries, more steering, and more blood pressure.

## Phase 1: Repository setup

Do this before any configuration branching.

### 1. Enter the project root

Work from the `pokoclaw/` directory.

### 2. Check the toolchain

Use the repo's declared tooling:

- Node.js 20+
- `pnpm`
- project scripts from `package.json`

The repo currently declares `pnpm@10.15.0`.

### 3. Install dependencies

```bash
pnpm install
```

### 4. Run an early environment check

```bash
pnpm build
```

Use this as a repo and toolchain check after install. It is useful early, but it does not validate the user's runtime config yet.

### 5. Know the main commands

```bash
pnpm build
pnpm lint
pnpm test
pnpm start
pnpm dev
pnpm preflight
```

## Phase 2: Detect OpenClaw

Before creating new Pokoclaw config, check whether the user already has OpenClaw config artifacts.

### Check these locations first

- `~/.openclaw/openclaw.json`
- `~/.openclaw/.env`
- legacy `.clawdbot` paths only as best-effort detection

Do not turn this into aggressive filesystem or OS credential-store discovery.

### If OpenClaw is detected

Summarize the visible state at a high level:

- providers
- models or provider/model mappings
- channel presence
- obvious credential patterns

Then ask whether the user wants to:

- import all relevant config
- import only part of it
- skip import and configure Pokoclaw manually

If they choose import, use:

- `docs/openclaw-import.md` for source-side migration rules
- `docs/configuration.md` for the target Pokoclaw config shape

### If OpenClaw is not detected, or the user declines import

Continue with clean setup and use `docs/configuration.md`.

## Phase 3A: OpenClaw import

Use `docs/openclaw-import.md` for details. The execution order is:

1. Summarize what looks importable.
2. Ask the user to choose import all, some, or none.
3. Convert only the chosen pieces into valid Pokoclaw config.
4. Preserve `env://...` refs when they are clear; otherwise generate placeholder `secrets.toml` entries.
5. Continue to Phase 3C: Required Feishu/Lark setup in `docs/feishu-lark-setup.md`.

## Phase 3B: Clean setup

Use `docs/configuration.md` for the concrete config structure.

### 1. Choose a realistic first provider path

Do not stop at "please configure a provider". Help the user pick one path first:

- Codex local auth when applicable
- OpenRouter
- an OpenAI-compatible API provider
- an Anthropic-compatible API provider

If the user wants web search or web fetch during normal use, also plan a Tavily provider during onboarding instead of leaving it for later.

Say the model recommendation clearly:

- Best experience: GPT-5 or Claude Sonnet.
- Acceptable floor: a strong mainstream model such as MiniMax 2.7 class.
- Friendly warning: trying to save money with a weak model often does not actually save trouble. It usually just turns "wow" into "why is my blood pressure up?"

### 2. Create the minimal runnable config

Write config under:

- `~/.pokoclaw/system/config.toml`
- `~/.pokoclaw/system/secrets.toml` if needed

For initial setup, always write:

- at least one provider
- at least one `[[models.catalog]]` entry
- all five scenario lists in `[models.scenarios]`

If the user wants web search or web fetch, also write:

- a Tavily provider
- `[tools.web.search]`
- `[tools.web.fetch]`

This phase is for LLM configuration. Complete channel setup separately in Phase 3C: Required Feishu/Lark setup.

Default scenario rule:

- if the user only has one model, use it for `chat`, `task`, `compaction`, `meditationBucket`, and `meditationConsolidation`
- if the user has a stronger main model and a cheaper or smaller model, use the stronger model for `chat` and `task`, and the cheaper or smaller model for `compaction`, `meditationBucket`, and `meditationConsolidation`

### 3. Handle credentials safely

- prefer `env://...` if the user already manages credentials through environment variables
- otherwise generate a `secrets.toml` skeleton with placeholders
- tell the user exactly which file and field they need to fill
- do not request the real secret in chat unless the user explicitly wants you to write it

## Phase 3C: Required Feishu/Lark setup

Current onboarding must include Feishu/Lark because it is the only supported channel right now.

- Run `docs/feishu-lark-setup.md`, Phase 3C: Required Feishu/Lark setup.
- If OpenClaw already has Feishu/Lark configured, first follow `docs/feishu-lark-setup.md`, Step 3C-1: Decide whether to reuse the existing OpenClaw bot.
- Recommended default: create a new bot or app instead of reusing the OpenClaw one.

## Phase 4: Validation and first run

After LLM config and Feishu/Lark config both exist, and the user has filled any manual secrets:

### 1. Start Pokoclaw

```bash
pnpm start
```

This is the final onboarding check because startup loads config from `~/.pokoclaw/system/`.

### 2. Use broader repo checks when useful

If the user wants more validation after startup, run one or more of:

```bash
pnpm lint
pnpm test
pnpm preflight
```

Pokoclaw does not yet provide a built-in background service or automatic restart path in this flow. For now, `pnpm start` is the normal launch path.

### Common failure categories

Check these first:

- TOML syntax errors
- missing `secret://...` targets
- missing `env://...` variables
- inconsistent provider or model IDs
- a provider with no usable model mapping
- an empty scenario list for a setup that is supposed to be runnable

When something is unclear, explain the gap and ask the user for a decision instead of guessing.

## Feishu/Lark

Feishu/Lark is not optional in the current product. Every runnable onboarding flow must complete `docs/feishu-lark-setup.md`, Phase 3C: Required Feishu/Lark setup, then return here for Phase 4: Validation and first run.
