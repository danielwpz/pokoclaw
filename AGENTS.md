# AGENTS

## Development Rules

- When running `pnpm add`, `pnpm install`, or similar dependency-changing commands in this repo:
  - if the command hits a permissions/sandbox problem, request escalated permissions directly
  - do **not** first try to work around it with `--store-dir` or other local store rewrites
  - reason: this repo has repeatedly hit false-detour issues from trying to patch pnpm store behavior instead of just requesting the needed permission
