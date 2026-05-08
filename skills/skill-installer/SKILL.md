---
name: skill-installer
description: Install third-party skills for Pokoclaw when the user asks an agent to install a skill, pastes a skill-store prompt, or pastes a skill-store CLI command. Use this for ClawHub, skills.sh, SkillHub, or unknown skill store installation requests.
skillKey: pokoclaw/skill-installer
---

# Skill Installer

Use this skill when the user asks you to install a skill for Pokoclaw, pastes a skill-store install prompt, or pastes a skill-store CLI command.

This skill does not manage commands the user already ran manually in their own terminal. It handles agent-managed installation.

## Core Rule

The task is not complete when an external store says "installed". The task is complete only when the skill is installed in a Pokoclaw-discoverable root and passes the acceptance checks below.

Reason: store CLIs can install into their own roots, active workspaces, or agent-specific locations that Pokoclaw does not read.

## Acceptance Checks

Always run these checks yourself at the end of the install.

Do this even when you followed a verified reference exactly. Do this even when the external CLI printed "installed" or "done". Do this even when the skill already appeared to be present.

The install is not complete until all checks pass:

- The final target directory is under the selected Pokoclaw root:
  - project-local: `<repo>/.agents/skills/<skill-dir>`
  - global: `~/.pokoclaw/skills/<skill-dir>`
- `SKILL.md` exists at the final target.
- `SKILL.md` frontmatter has non-empty `name` and `description`.
- The actual skill identity is taken from `SKILL.md` frontmatter, not only from the store slug or display title.
- Setup-relevant files were inspected but not executed.
- Store provenance was preserved when available:
  - for global installs, provenance is stored inside the final skill directory;
  - for project-local installs, provenance is either stored inside the final skill directory or in a project lock file that remains with the project.
- Temporary install or staging files were cleaned up.
- Any broader environment change was skipped unless the user approved it.

If any acceptance check fails, report the blocker and do not claim the skill is installed for Pokoclaw.

## Read References

If the request matches a verified channel, read the matching reference before installing:

- ClawHub: `references/clawhub.md`
- skills.sh / `npx skills`: `references/skills-sh.md`
- SkillHub: `references/skillhub.md`

If the request uses an unknown channel, investigate that channel first, then still satisfy the same acceptance checks in this file.

## Decide Intent First

If the user pastes a store CLI command, decide whether they want:

- a Pokoclaw skill install, or
- the raw external command run against that external tool's own environment.

If the user explicitly asks to operate the external tool itself, ask before running commands that change real global or workspace state.

If the user asks in a Pokoclaw context, or the request is ambiguous, treat it as a Pokoclaw skill install. Do not blindly run the pasted command as the final action.

Reason: users often paste store-provided commands as shorthand for "install this skill for my agent"; those commands may install somewhere Pokoclaw cannot discover.

## Select Target

For project-local installs, use:

```text
<repo>/.agents/skills/<skill-dir>/SKILL.md
```

For global Pokoclaw installs, use:

```text
~/.pokoclaw/skills/<skill-dir>/SKILL.md
```

Do not use `~/.agents/skills`, `~/.openclaw/workspace-*/skills`, or a store-specific global directory as the final target unless Pokoclaw is explicitly configured to read it.

Reason: Pokoclaw currently reads its own global root and repo-local `.agents/skills`; it does not automatically read every other agent ecosystem's global root.

## Install Procedure

1. Parse the requested skill identity:
   - extract store, slug, package URL, page URL, display title, owner, and version if present;
   - do not assume slug, display title, and `SKILL.md` frontmatter `name` are the same.

2. Inspect available store metadata before installing:
   - use only metadata you can verify from the store, repository, downloaded package, or installed files;
   - do not invent setup requirements, hooks, environment variables, or dependencies.

3. If the target directory already exists, inspect it before modifying it:
   - if it already passes the acceptance checks and matches the requested skill identity plus any source/version constraints, report that the skill is already installed;
   - if it passes the acceptance checks but the source or version differs from the request, report the conflict and ask before replacing or updating it;
   - if it is invalid or incomplete, report the failed checks and ask before replacing, updating, or merging it;
   - do not overwrite an existing target directory unless the user explicitly approves.

4. Install or materialize the skill into the selected Pokoclaw target:
   - use a verified channel-specific direct target option when one exists;
   - otherwise stage or install through the store, then copy or symlink only the requested skill into the selected Pokoclaw target;
   - keep the work scoped to the requested skill only.

5. Preserve provenance when available:
   - keep store metadata files such as `_meta.json`, `.clawhub/origin.json`, lock entries, or source metadata if they are part of the installed skill;
   - if provenance exists only in an external lock or staging file and the final target will not include that file, write a per-skill provenance file inside the final skill directory;
   - do not copy unrelated store caches or registry state into the skill directory.

6. Inspect after installation:
   - read `SKILL.md` frontmatter;
   - report the installed skill name, description, source, version if known, and final target path;
   - run the setup inspection checklist below.

7. Do not run setup scripts, enable hooks, edit shell profiles, install extra CLIs, or change broader environment state unless the user explicitly approves.

8. Clean up temporary material:
   - remove temporary download/staging directories;
   - for test installs, restore pre-test lock files and remove test-created symlinks or skill directories;
   - do not remove pre-existing user files.

## Unknown Channels

For an unverified store or installer:

1. Read its help/docs or inspect the command output to determine the real install root.
2. Check whether it supports an explicit target root.
3. If it supports a target root, direct it to the selected Pokoclaw target root.
4. If it does not support a target root, install or download in a controlled way, then copy or symlink the requested skill into the selected Pokoclaw target.
5. Record any verified channel behavior if the user is asking you to improve installer support.

Do not rely on store branding, command names, or current working directory to infer where files landed. Verify the actual files.

## Setup Inspection Checklist

Inspect these files and paths when they exist in the installed skill. Do not execute them unless the user explicitly approves.

- `README*`
- `package.json`
- `setup*`
- `install*`
- `hooks/`
- `hook*`
- `scripts/`
- `references/`
- `assets/`
- `*.sh`
- `*.js`
- `*.ts`
- `_meta*`
- `metadata*`
- `.clawhub/origin.json`
- `.skills-sh/origin.json`
- `.skillhub/origin.json`
- store-specific lock or provenance files, including copied per-skill lock entries

Reason: setup requirements and executable side effects are often documented in these files, and different stores package them differently.
