# Real LLM Integration Tests

These tests call a real LLM API. They are intentionally separated from the default
test suite and only run via:

```bash
pnpm test:integration:llm
```

Setup:

1. Copy `.env.integration.example` to `.env.integration.local`
2. Fill in the real provider details
3. Run the command above

Required variables:

- `POKOCLAW_IT_LLM_API`
- `POKOCLAW_IT_LLM_API_KEY`
- `POKOCLAW_IT_LLM_UPSTREAM_ID`
- `POKOCLAW_IT_DEEPSEEK_API_KEY`
- `POKOCLAW_IT_DEEPSEEK_BASE_URL`
- `POKOCLAW_IT_DEEPSEEK_UPSTREAM_ID`

Optional variables:

- `POKOCLAW_IT_LLM_BASE_URL`
- `POKOCLAW_IT_LLM_CONTEXT_WINDOW`
- `POKOCLAW_IT_LLM_MAX_OUTPUT_TOKENS`
- `POKOCLAW_IT_LLM_SUPPORTS_TOOLS`
- `POKOCLAW_IT_LLM_SUPPORTS_VISION`
- `POKOCLAW_IT_LLM_SUPPORTS_REASONING`
- `POKOCLAW_IT_DEEPSEEK_CONTEXT_WINDOW`
- `POKOCLAW_IT_DEEPSEEK_MAX_OUTPUT_TOKENS`

Notes:

- Prefer running the full suite in the Linux test container:

  ```bash
  pnpm linux:docker run -- env VITEST_MAX_WORKERS=2 pnpm test:integration
  ```

  The container has a fresh test-user home, so AgentLoop's default memory and
  skill discovery cannot inject your host's personal workspace into requests.
  The local integration env file is used for provider authentication; test
  prompts, transcripts, and the repo-local skill fixture are synthetic.
- The main app stores config under `~/.pokoclaw/system/config.toml` and `~/.pokoclaw/system/secrets.toml`
- Integration tests only use the local env file to generate temporary config files
- Default `pnpm test` excludes everything under `tests/integration/`
