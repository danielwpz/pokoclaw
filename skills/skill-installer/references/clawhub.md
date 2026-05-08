# ClawHub

Use this reference when the user asks for a ClawHub skill, pastes a ClawHub page prompt, or pastes:

```bash
openclaw skills install <slug>
```

## Required Handling

If the user wants the skill installed for Pokoclaw, do not run `openclaw skills install <slug>` as the final install action.

Treat `<slug>` as the ClawHub skill identity, then materialize the final skill into the selected Pokoclaw root:

- project-local: `<repo>/.agents/skills/<skill-dir>`
- global: `~/.pokoclaw/skills/<skill-dir>`

Reason: `openclaw skills install` installs into the active OpenClaw workspace, such as `~/.openclaw/workspace-*/skills`, which Pokoclaw does not currently scan.

If you use `openclaw skills install <slug>` as a staging method because no direct package download path is available, do all of the following:

1. Snapshot the expected OpenClaw active workspace skill path and lock path first.
2. Run the command only for the requested skill.
3. Locate the installed skill from the command output or verified filesystem path.
4. Copy or symlink only that skill into the selected Pokoclaw target.
5. Preserve `_meta.json` and `.clawhub/origin.json` if present.
6. Remove the staged OpenClaw skill and restore/remove test-created ClawHub lock files unless the user explicitly asked to keep the OpenClaw install too.

Reason: staging through OpenClaw changes OpenClaw state. A Pokoclaw install must not leave unrelated OpenClaw workspace changes behind.

## Verified CLI Behavior

Observed command:

```bash
openclaw skills install self-improving-agent
```

Observed result:

```text
Installed self-improving-agent@3.0.21 -> ~/.openclaw/workspace-feishu-default/skills/self-improving-agent
```

The command also created:

```text
~/.openclaw/workspace-feishu-default/.clawhub/lock.json
```

`openclaw skills install --help` showed no target-root option. It only exposed `--force` and `--version`.

## Identity Rule

Do not assume slug, page title, and frontmatter name are identical.

Observed example:

- ClawHub slug: `self-improving-agent`
- Prompt title: `Self-Improving Agent`
- `SKILL.md` frontmatter name: `self-improvement`

After install, use `SKILL.md` frontmatter `name` as the actual skill identity.

## Expected Package Shape

The observed ClawHub package contained:

- `SKILL.md`
- `_meta.json`
- `.clawhub/origin.json`
- `README.md`
- `references/`
- `hooks/`
- `scripts/`
- `assets/`

Preserve `_meta.json` and `.clawhub/origin.json` when available.

Reason: they are provenance metadata for source, version, and update behavior.

## Setup Rule

Do not run hooks, scripts, or setup commands from the installed skill without explicit user approval.

Reason: ClawHub skills can include executable `hooks/` and `scripts/`; installation and setup are separate trust decisions.

## Completion

The ClawHub install is complete only after the requested skill exists in the selected Pokoclaw target and passes the acceptance checks in `../SKILL.md`.
