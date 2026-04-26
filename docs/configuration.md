# Pokoclaw Configuration Guide for AI Setup Flows

Use this document when you are creating or validating Pokoclaw configuration during onboarding. Every setup path should end in valid config under `~/.pokoclaw/system/`.

## Files

Treat these layers separately:

- `~/.pokoclaw/system/config.toml`: normal, non-sensitive configuration
- `~/.pokoclaw/system/secrets.toml`: sensitive values only
- SQLite runtime state: runtime data, not part of normal onboarding file-writing

Do not collapse these into one file.

## Current channel requirement

Feishu/Lark is currently the only supported channel. A runnable onboarding setup should therefore include:

- LLM provider and model config
- Feishu/Lark channel config

Do not treat channel setup as optional during onboarding.

In the overall flow, channel setup is completed independently in `docs/feishu-lark-setup.md`, Phase 3C: Required Feishu/Lark setup.

## Supported credential patterns

### Direct non-secret config

Keep ordinary provider metadata in `config.toml`, for example:

- API kind
- base URL
- model metadata

### `secret://...` refs

Use `*_ref` fields when the value should come from `secrets.toml`.

```toml
[providers.openrouter]
api = "openai-responses"
baseUrl = "https://openrouter.ai/api/v1"
apiKey_ref = "secret://llm/openrouter/apiKey"
```

```toml
[llm.openrouter]
apiKey = "paste-your-openrouter-api-key-here"
```

### `env://VAR_NAME` refs

Use `*_ref` fields when the value should come from an environment variable.

```toml
[providers.openrouter]
api = "openai-responses"
baseUrl = "https://openrouter.ai/api/v1"
apiKey_ref = "env://OPENROUTER_API_KEY"
```

### `codex-local`

Use `authSource = "codex-local"` only with `api = "openai-codex-responses"`.

```toml
[providers.openai_codex]
api = "openai-codex-responses"
authSource = "codex-local"
```

Do not set `baseUrl` or `apiKey` on the same provider when using `codex-local`.

## Minimal runnable config

For first-run onboarding, write:

- at least one provider in `providers`
- at least one `[[models.catalog]]` entry
- all five lists in `[models.scenarios]`
- Feishu/Lark channel config under `[channels.lark.installations.<id>]`

The provider and model templates below cover the LLM side first. Complete the required channel separately in `docs/feishu-lark-setup.md`, Phase 3C: Required Feishu/Lark setup.

If the user wants web search or web fetch, also configure a Tavily provider plus `[tools.web.search]` and `[tools.web.fetch]`.

The five scenario keys are:

- `chat`
- `task`
- `compaction`
- `meditationBucket`
- `meditationConsolidation`

For onboarding, do not leave them blank.

Default mapping rule:

- if the user only has one model, use the same model in all five scenarios
- if the user has two useful models, use the stronger model for `chat` and `task`, and the cheaper or smaller model for `compaction`, `meditationBucket`, and `meditationConsolidation`

## Model recommendation during onboarding

Say this clearly instead of treating all models as equal:

- Best experience: GPT-5 or Claude Sonnet.
- Acceptable floor: DeepSeek V4 Pro or a strong mainstream model such as MiniMax 2.7 class.
- DeepSeek V4 Pro is a practical lower-bound recommendation, not the best-experience tier.
- Weak models are a false economy for this product. They often do not actually save effort or tokens; they mostly create more retries, more steering, and more frustration.

If importing or selecting models, steer the user toward a good main model for `chat` and `task`. Pokoclaw's workflow quality depends heavily on tool use, multi-step execution, and judgment under uncertainty, so poor models degrade the whole product, not just wording quality.

## Minimal templates

### Template A: Codex local, one model everywhere

This matches the real `codex-local` pattern used in a working local setup for this repo.

```toml
[providers.openai_codex]
api = "openai-codex-responses"
authSource = "codex-local"

[[models.catalog]]
id = "codex-gpt5.4"
provider = "openai_codex"
upstreamId = "gpt-5.4"
contextWindow = 200000
maxOutputTokens = 16384
supportsTools = true
supportsVision = true
[models.catalog.reasoning]
enabled = true
effort = "high"

[models.scenarios]
chat = ["codex-gpt5.4"]
task = ["codex-gpt5.4"]
compaction = ["codex-gpt5.4"]
meditationBucket = ["codex-gpt5.4"]
meditationConsolidation = ["codex-gpt5.4"]

[channels.lark.installations.default]
enabled = true
appId = "cli_xxx"
appSecret_ref = "secret://channels/lark/default/appSecret"
connectionMode = "websocket"
```

Matching `secrets.toml`:

```toml
[channels.lark.default]
appSecret = "paste-your-feishu-or-lark-app-secret-here"
```

### Template B: OpenRouter via environment variable

Replace `upstreamId` with the OpenRouter model the user actually wants. The structure stays the same.

```toml
[providers.openrouter]
api = "openai-responses"
baseUrl = "https://openrouter.ai/api/v1"
apiKey_ref = "env://OPENROUTER_API_KEY"

[[models.catalog]]
id = "openrouter-main"
provider = "openrouter"
upstreamId = "qwen/qwen3-next-80b-a3b-instruct"
contextWindow = 200000
maxOutputTokens = 16384
supportsTools = true
supportsVision = true
[models.catalog.reasoning]
enabled = true

[models.scenarios]
chat = ["openrouter-main"]
task = ["openrouter-main"]
compaction = ["openrouter-main"]
meditationBucket = ["openrouter-main"]
meditationConsolidation = ["openrouter-main"]

[channels.lark.installations.default]
enabled = true
appId = "cli_xxx"
appSecret_ref = "secret://channels/lark/default/appSecret"
connectionMode = "websocket"
```

Matching `secrets.toml`:

```toml
[channels.lark.default]
appSecret = "paste-your-feishu-or-lark-app-secret-here"
```

### Template C: DeepSeek V4 Pro direct provider

This is a direct DeepSeek setup using a secret reference. Replace the secret value in `secrets.toml`; do not put the API key in `config.toml`.

```toml
[providers.deepseek]
api = "openai-completions"
baseUrl = "https://api.deepseek.com"
apiKey_ref = "secret://llm/deepseek/apiKey"

[[models.catalog]]
id = "deepseek-v4"
provider = "deepseek"
upstreamId = "deepseek-v4-pro"
contextWindow = 200000
maxOutputTokens = 32000
supportsTools = true
supportsVision = true
[models.catalog.reasoning]
enabled = true

[models.scenarios]
chat = ["deepseek-v4"]
task = ["deepseek-v4"]
compaction = ["deepseek-v4"]
meditationBucket = ["deepseek-v4"]
meditationConsolidation = ["deepseek-v4"]

[channels.lark.installations.default]
enabled = true
appId = "cli_xxx"
appSecret_ref = "secret://channels/lark/default/appSecret"
connectionMode = "websocket"
```

Matching `secrets.toml`:

```toml
[llm.deepseek]
apiKey = "paste-your-deepseek-api-key-here"

[channels.lark.default]
appSecret = "paste-your-feishu-or-lark-app-secret-here"
```

### Template D: Tavily for web search and web fetch

Use this when the user wants Pokoclaw to search the web or fetch web pages during normal use.

Tavily is the current practical path here. Tell the user it can be registered with a free account at `https://www.tavily.com/`, then help them get an API key and wire it through `env://...` or `secret://...`.

Explain the difference clearly:

- `web search` is for finding current information or locating relevant pages on the internet.
- `web fetch` is for opening a specific page and reading its contents.
- Example: use `web search` to find the latest official changelog for a tool, then use `web fetch` to read that changelog page and summarize the important changes.

```toml
[providers.tavily]
api = "tavily"
apiKey_ref = "env://TAVILY_API_KEY"

[tools.web.search]
enabled = true
provider = "tavily"

[tools.web.fetch]
enabled = true
provider = "tavily"
```

If the user prefers file-based secrets:

```toml
[providers.tavily]
api = "tavily"
apiKey_ref = "secret://tools/tavily/apiKey"
```

Matching `secrets.toml`:

```toml
[tools.tavily]
apiKey = "paste-your-tavily-api-key-here"
```

### If the user prefers file-based secrets

Keep `config.toml` like this:

```toml
[providers.openrouter]
api = "openai-responses"
baseUrl = "https://openrouter.ai/api/v1"
apiKey_ref = "secret://llm/openrouter/apiKey"
```

And write this `secrets.toml` skeleton:

```toml
[llm.openrouter]
apiKey = "paste-your-openrouter-api-key-here"

[channels.lark.default]
appSecret = "paste-your-feishu-or-lark-app-secret-here"
```

### If the user has a stronger model and a smaller model

Once both model IDs already exist in `models.catalog`, this split is a good starting point:

```toml
[models.scenarios]
chat = ["main-model"]
task = ["main-model"]
compaction = ["small-model"]
meditationBucket = ["small-model"]
meditationConsolidation = ["small-model"]
```

## Secret-handling rule

This rule is mandatory during onboarding:

- do not ask the user to paste real secrets into chat by default
- prefer `env://...` when the user already manages secrets through environment variables
- otherwise generate a `secrets.toml` skeleton with placeholders
- only write a real secret into a file if the user explicitly asks

## Common validation problems

Check these first:

- missing `secret://...` target
- missing `env://...` variable
- both a concrete field and a matching `*_ref` field are present
- `codex-local` is paired with the wrong `api`
- a model references an unknown provider
- a scenario references an unknown model ID

Do not declare onboarding complete until the config is understandable and runnable.

## How to use this with the other docs

- `docs/onboarding.md` tells you when to use this file.
- `docs/openclaw-import.md` tells you what is safe to import from OpenClaw.
- This file tells you what the final Pokoclaw config should look like.
