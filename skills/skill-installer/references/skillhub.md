# SkillHub

Use this reference when the user asks to install a skill through SkillHub or pastes instructions such as:

```bash
curl -fsSL https://skillhub.cn/install/install.sh | bash
skillhub install tencent-docs
```

## Required Command Shape

Do not run bare `skillhub install <slug>` from the Pokoclaw repo.

Reason: SkillHub defaults to `./skills`, and in the Pokoclaw repo that path is the built-in skill directory.

Use `--dir` before the subcommand.

For global Pokoclaw installs, run:

```bash
skillhub --dir ~/.pokoclaw/skills install <slug>
```

For project-local Pokoclaw installs, run:

```bash
skillhub --dir <repo>/.agents/skills install <slug>
```

Do not write:

```bash
skillhub install <slug> --dir <root>
```

Reason: `--dir` is a top-level SkillHub option, not an `install` subcommand option.

## CLI Availability

If `skillhub` is not installed, ask before installing the SkillHub CLI.

If the user pasted instructions that say to install SkillHub first, install only the CLI needed for this skill-store operation. Do not set SkillHub as a broader preferred source or change shell configuration unless the user explicitly approves.

Reason: installing a CLI and changing the user's preferred source are broader environment changes.

## Verified Behavior

Observed CLI:

```bash
skillhub --help
```

Important options:

- `--dir DIR`: install root directory, default `./skills`
- `--index INDEX`: skills index path or URI
- `--skip-self-upgrade`: skip startup self-upgrade check

Observed install:

```bash
skillhub --skip-self-upgrade --dir /private/tmp/pokoclaw-skillhub-install.E1kaRS install tencent-docs
```

Result:

```text
Installed: tencent-docs -> /private/tmp/pokoclaw-skillhub-install.E1kaRS/tencent-docs
```

Observed package shape:

- `SKILL.md`
- `setup.sh`
- `import_file.sh`
- `generate_slide.js`
- `ocr.js`
- `references/`
- `smartcanvas/`
- `doc/`
- `sheet/`

Observed `SKILL.md` frontmatter included:

- `name`
- `description`
- `homepage`
- `version`
- `author`
- `metadata`

## Setup Rule

Do not run `setup.sh` or other installed scripts without explicit user approval.

Reason: SkillHub skills can include executable setup and helper scripts; installation and setup are separate trust decisions.

## Completion

When `--dir` is set to the selected Pokoclaw target root, SkillHub can install directly into the correct final root. No copy or symlink is needed unless the installed directory fails the acceptance checks in `../SKILL.md`.
