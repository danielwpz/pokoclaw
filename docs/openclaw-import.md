# OpenClaw Import Guide for AI Setup Flows

Use this document when the user already has OpenClaw config and wants to carry some or all of it into Pokeclaw.

## Goal

Do not try to preserve every OpenClaw internal detail. The goal is to migrate the parts that are visible, high-confidence, and still useful in Pokeclaw.

Read this together with:

- `docs/onboarding.md` for execution order
- `docs/configuration.md` for the final Pokeclaw target shape

## What to inspect

Check these artifacts first:

- `~/.openclaw/openclaw.json`
- `~/.openclaw/.env`

Legacy `.clawdbot` paths are best-effort only.

Do not depend on source-code inference, OS keychains, or unusual secret backends as if they were a stable import path.

## Workflow

### 1. Detect whether OpenClaw is configured

If no clear OpenClaw config artifacts are present, stop the import path and continue with clean Pokeclaw setup.

### 2. Summarize what looks importable

Before changing Pokeclaw config, summarize the visible state at a high level:

- providers
- models or provider/model mappings
- channel presence
- obvious credential patterns

### 3. Ask the user what to import

Offer a clear choice:

- import all relevant config
- import only a selected subset
- skip import

Do not assume that every OpenClaw provider or model should be copied into Pokeclaw.

### 4. Convert only the chosen pieces

Translate the selected pieces into the Pokeclaw config model from `docs/configuration.md`.

Keep these rules:

- preserve `env://...` refs when that path is clear and stable
- generate placeholder `secrets.toml` entries when file-based secrets are needed
- do not guess low-confidence secret resolution paths
- produce understandable Pokeclaw config, not a 1:1 clone of OpenClaw internals

### 5. Validate like a normal Pokeclaw setup

After import:

- check that providers, models, and scenarios line up
- resolve unsupported or uncertain pieces with the user
- complete Feishu/Lark setup because channel config is still required for startup
- finish with the normal onboarding validation flow

## Confidence tiers

### High confidence

These are good candidates for direct migration after user confirmation:

- provider definitions clearly visible in standard OpenClaw config files
- model definitions or provider/model mappings that translate cleanly into Pokeclaw
- obvious env-managed credentials that can stay env-managed

### Medium confidence

These need a short explanation and explicit user confirmation:

- many providers where the user probably only wants a subset
- fields whose meaning does not map 1:1 into Pokeclaw
- partial provider metadata that needs interpretation

### Low confidence or unsupported

Do not migrate these automatically by default:

- OS keychains or system-managed secret stores
- file, exec, or other secret backends whose runtime resolution path is unclear
- OAuth or auth-profile stores that do not map cleanly into current Pokeclaw support
- anything that depends on source-code knowledge instead of visible user config

For these cases:

- do not guess
- explain the limitation briefly
- provide a clean manual Pokeclaw path instead

## Feishu/Lark note

OpenClaw may contain Feishu-related config. If it does:

- mention that it exists
- do not force a full automatic Feishu/Lark migration
- use `docs/feishu-lark-setup.md` for the manual target-side setup
- remind the user that current Pokeclaw Feishu/Lark support is intended for one personal assistant, not a shared team bot

Even if OpenClaw import succeeds for LLM config, onboarding is not complete until Feishu/Lark is configured, because it is the current required channel.
