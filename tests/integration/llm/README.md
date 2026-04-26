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

- The main app stores config under `~/.pokoclaw/system/config.toml` and `~/.pokoclaw/system/secrets.toml`
- Integration tests only use the local env file to generate temporary config files
- Default `pnpm test` excludes everything under `tests/integration/`
