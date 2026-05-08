# skills.sh / npx skills

Use this reference when the user asks to install a skill through skills.sh or pastes a command like:

```bash
npx skills add https://github.com/vercel-labs/skills --skill find-skills
```

## Required Project-Local Command

For project-local Pokoclaw installs, run the non-interactive form:

```bash
npx skills add <repo-or-url> --skill <skill> -y
```

Do not omit `-y`.

Reason: without `-y`, the CLI can stop at an interactive agent-selection prompt and leave the agent blocked.

## Verified Project Behavior

Observed command:

```bash
npx skills add https://github.com/vercel-labs/skills --skill find-skills -y
```

Observed outputs in the repo:

- real skill files:
  - `<repo>/.agents/skills/find-skills/SKILL.md`
- symlink:
  - `<repo>/.claude/skills/find-skills -> ../../.agents/skills/find-skills`
- symlink:
  - `<repo>/skills/find-skills -> ../.agents/skills/find-skills`
- lock update:
  - `<repo>/skills-lock.json`

`<repo>/.agents/skills/<skill>` is a Pokoclaw-scanned project-local root, so the real skill files satisfy the project-local target requirement.

## Expected Side Effects

Treat these as expected skills.sh project state, not as install failure:

- `skills-lock.json` is updated.
- `.claude/skills/<skill>` may be created as a symlink.
- `skills/<skill>` may be created as a symlink.

Report these side effects in the final answer.

## Pokoclaw Repo Warning

If the current repo is Pokoclaw itself, do not commit a `skills/<skill>` symlink created by skills.sh.

Reason: this repo's `skills/` directory is the built-in skill directory. A skills.sh compatibility symlink there can look like a built-in skill change and must not be committed accidentally.

For temporary probes in this repo, remove:

- `<repo>/.agents/skills/<skill>`
- `<repo>/.claude/skills/<skill>`
- `<repo>/skills/<skill>`

and restore `skills-lock.json` if the install was only a test.

## Global Installs

Do not treat skills.sh global installs as complete for Pokoclaw unless the final skill is also present under `~/.pokoclaw/skills`.

Observed global listing:

```bash
npx skills ls -g --json
```

Existing global installs were rooted at:

```text
~/.agents/skills/<skill>
```

Agent-specific global paths such as `~/.claude/skills/<skill>` and `~/.codex/skills/<skill>` can be symlinks to `~/.agents/skills/<skill>`.

Pokoclaw does not currently scan `~/.agents/skills` by default.

For global Pokoclaw installs, copy or symlink the requested skill into:

```text
~/.pokoclaw/skills/<skill>
```

unless Pokoclaw has been explicitly configured to scan `~/.agents/skills`.

## Target Root

No explicit `--dir`, `--root`, `--target`, or `--prefix` option was observed in `npx skills --help`.

Reason: if a direct target-root option is not available, final Pokoclaw global materialization must be done by copy or symlink.
