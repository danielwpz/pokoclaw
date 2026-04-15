# OpenClaw Import Guide for AI Setup Flows

Use this document when the user already has OpenClaw config and wants to carry some or all of it into Pokoclaw.

## Goal

Do not try to preserve every OpenClaw internal detail. The goal is to migrate the parts that are visible, high-confidence, and still useful in Pokoclaw.

Read this together with:

- `docs/onboarding.md`, Phase 3A: OpenClaw import, for execution order
- `docs/configuration.md` for the final Pokoclaw target shape

## What to inspect

Check these artifacts first:

- `~/.openclaw/openclaw.json`
- `~/.openclaw/.env`

Legacy `.clawdbot` paths are best-effort only.

Do not depend on source-code inference, OS keychains, or unusual secret backends as if they were a stable import path.

## Workflow

### 1. Detect whether OpenClaw is configured

If no clear OpenClaw config artifacts are present, stop the import path and continue with clean Pokoclaw setup.

### 2. Summarize what looks importable

Before changing Pokoclaw config, summarize the visible state at a high level:

- providers
- models or provider/model mappings
- channel presence
- obvious credential patterns

### 3. Ask the user what to import

Offer a clear choice:

- import all relevant config
- import only a selected subset
- skip import

Do not assume that every OpenClaw provider or model should be copied into Pokoclaw.

### 4. Convert only the chosen pieces

Translate the selected pieces into the Pokoclaw config model from `docs/configuration.md`.

Keep these rules:

- preserve `env://...` refs when that path is clear and stable
- generate placeholder `secrets.toml` entries when file-based secrets are needed
- do not guess low-confidence secret resolution paths
- produce understandable Pokoclaw config, not a 1:1 clone of OpenClaw internals
- do not treat every imported model as equally suitable; if the visible model set is weak, say so clearly and recommend a stronger main model
- best experience: GPT-5 or Claude Sonnet; acceptable floor: a strong mainstream model such as MiniMax 2.7 class
- if the user expects web search or web fetch, import or add a Tavily provider during onboarding instead of leaving web tools unconfigured

### 5. Validate like a normal Pokoclaw setup

After import:

- check that providers, models, and scenarios line up
- resolve unsupported or uncertain pieces with the user
- complete `docs/feishu-lark-setup.md`, Phase 3C: Required Feishu/Lark setup, because channel config is still required for startup
- finish with the normal onboarding validation flow

## Confidence tiers

### High confidence

These are good candidates for direct migration after user confirmation:

- provider definitions clearly visible in standard OpenClaw config files
- model definitions or provider/model mappings that translate cleanly into Pokoclaw
- obvious env-managed credentials that can stay env-managed

### Medium confidence

These need a short explanation and explicit user confirmation:

- many providers where the user probably only wants a subset
- fields whose meaning does not map 1:1 into Pokoclaw
- partial provider metadata that needs interpretation

### Low confidence or unsupported

Do not migrate these automatically by default:

- OS keychains or system-managed secret stores
- file, exec, or other secret backends whose runtime resolution path is unclear
- OAuth or auth-profile stores that do not map cleanly into current Pokoclaw support
- anything that depends on source-code knowledge instead of visible user config

For these cases:

- do not guess
- explain the limitation briefly
- provide a clean manual Pokoclaw path instead

## Feishu/Lark note

OpenClaw may contain Feishu-related config. If it does:

- mention that it exists
- do not force a full automatic Feishu/Lark migration
- do not directly copy the existing OpenClaw Feishu/Lark bot config into Pokoclaw
- first ask the user whether they want to reuse the same bot or create a new one
- explain that reusing the same bot is risky because one channel with two active backends can conflict or mix behavior
- recommend creating a new bot or app
- use `docs/feishu-lark-setup.md`, Step 3C-1: Decide whether to reuse the existing OpenClaw bot, before the rest of the Feishu/Lark setup
- remind the user that current Pokoclaw Feishu/Lark support is intended for one personal assistant, not a shared team bot

Even if OpenClaw import succeeds for LLM config, onboarding is not complete until `docs/feishu-lark-setup.md`, Phase 3C: Required Feishu/Lark setup, is complete.
