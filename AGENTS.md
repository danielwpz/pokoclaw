# AGENTS

Guidance for coding agents working in this repository.

## Project Shape

- TypeScript / Node.js / pnpm project
- Personal AI assistant focused on long-running, observable task execution
- Feishu/Lark is currently the only supported channel
- The codebase is early-stage and should be changed incrementally

## Core Rules

- Make the best change that solves the task.
- Preserve existing user work.
- Prioritize code quality, maintainability, extensibility, and product quality above short-term shortcuts.
- Do not reject a refactor just because it is speculative; use judgment and make the change when it improves the result materially.
- If behavior changes, add or update tests.
- If user-facing setup or usage changes, update the relevant repository docs in the same change when practical.
- Keep explanations concrete and tied to actual code paths.

## File And Git Safety

- Never use destructive git commands such as `git reset --hard` or `git checkout --` unless explicitly requested and approved.
- Do not amend commits unless the user explicitly asks.
- Never revert changes you did not make.
- If you notice unrelated unexpected modifications, stop and ask how to proceed if they conflict with the task.
- Prefer `apply_patch` for manual file edits.
- Do not use Python for file editing when a shell command or `apply_patch` is sufficient.
- Prefer ASCII when editing files unless the file already uses non-ASCII and there is a clear reason to match it.

## Dependency Commands

- When running `pnpm add`, `pnpm install`, or similar dependency-changing commands:
  - if the command hits a permissions or sandbox problem, request escalated permissions directly
  - do **not** first try to work around it with `--store-dir` or other local store rewrites
  - reason: this repository has repeatedly hit false-detour issues from trying to patch pnpm store behavior instead of just requesting the needed permission

## Commands

- `pnpm install` - install dependencies
- `pnpm build` - TypeScript check (`tsc --noEmit`)
- `pnpm typecheck` - same as `pnpm build`
- `pnpm lint` - Biome checks
- `pnpm format` - Biome write/fix
- `pnpm test` - Vitest suite
- `pnpm test:integration` - integration tests
- `pnpm preflight` - build + format + lint + test
- `pnpm start` - run the app once
- `pnpm dev` - run the app with watch mode

Prefer the narrowest relevant test command first. Run `pnpm preflight` for larger or user-facing changes.

## Code Quality

- Treat `any` as banned unless there is a strong reason and the codebase already uses the pattern in that area.
- Keep Biome formatting and lint rules green.
- Follow existing naming and layering conventions.
- Do not add abstractions unless they reduce real duplication or clarify a real boundary.
- Prefer explicit data flow over hidden magic.

## Architecture Boundaries

- The intended runtime roles are:
  - Main Agent
  - SubAgent
  - TaskAgent
- Keep separation between:
  - agent/runtime logic
  - orchestration
  - security and sandboxing
  - channel adaptation
  - Feishu/Lark rendering and callbacks
- Do not leak Feishu-specific behavior into lower-level runtime or security code.
- Keep secrets in the host/runtime side, not inside agent-visible payloads.
- Preserve the split between normal config, secrets, and SQLite runtime state.

## Config And Secrets

- Normal config and hard boundaries belong in the system config files used by the application.
- Secrets belong in the system secrets file used by the application.
- SQLite runtime data belongs in the application's runtime database.
- Do not assume the user wants secrets written into chat or committed into the repository.
- Prefer environment-based secret references when the user already manages secrets that way.

## Security

- Never commit real secrets.
- Do not print or echo secrets unnecessarily.
- Treat local environment files as private machine state.
- If a task reveals a leaked credential, recommend rotation immediately.
- Respect sandbox and permission boundaries rather than bypassing them.

## Testing Expectations

- For behavior changes, add tests that cover the changed behavior.
- For bug fixes, add a regression test when practical.
- For larger changes, run `pnpm preflight`.
- For smaller targeted changes, run the narrowest relevant test plus any necessary type check.
- If a real-LLM integration test fails, prove which layer is wrong before changing prompts or runtime logic.
- Before creating a commit, run `pnpm preflight`.

## Review Behavior

- If the user asks for a review, prioritize:
  - correctness
  - regressions
  - missing tests
  - operational and security risks
- Keep review comments practical and decision-oriented.

## Repo Notes

- Onboarding expects a valid runnable setup and a successful `pnpm start`.
- Prefer incremental changes over large rewrites.
