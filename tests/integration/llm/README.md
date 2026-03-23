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

- `POKECLAW_IT_LLM_API`
- `POKECLAW_IT_LLM_API_KEY`
- `POKECLAW_IT_LLM_UPSTREAM_ID`

Optional variables:

- `POKECLAW_IT_LLM_BASE_URL`
- `POKECLAW_IT_LLM_CONTEXT_WINDOW`
- `POKECLAW_IT_LLM_MAX_OUTPUT_TOKENS`
- `POKECLAW_IT_LLM_SUPPORTS_TOOLS`
- `POKECLAW_IT_LLM_SUPPORTS_VISION`
- `POKECLAW_IT_LLM_SUPPORTS_REASONING`

Notes:

- The main app still uses `config.toml` and `secrets.toml`
- Integration tests only use the local env file to generate temporary config files
- Default `pnpm test` excludes everything under `tests/integration/`
