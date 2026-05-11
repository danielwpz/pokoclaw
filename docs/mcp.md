# MCP Configuration

MCP is optional. You do not need it for the default onboarding flow, but you can
configure MCP servers when you want Pokoclaw to expose tools from external MCP
providers.

MCP is off when no `[mcp]` config is present. Once you add one or more
`[mcp.servers.<name>]` entries, MCP starts automatically. You do not need an
`enabled = true` flag for normal setup.

## Recommended remote setup

Use `streamable_http` for hosted MCP servers that provide an HTTP MCP endpoint.

```toml
[mcp.servers.linear]
transport = "streamable_http"
url = "https://mcp.linear.app/mcp"
tool_policy = "ask"
```

`tool_policy = "ask"` is the default and safest option. It routes MCP tool
calls through the same approval system as other tools, including task and cron
delegated approval when needed.

## Secrets

Do not put real tokens directly in `config.toml`. Use the normal config
reference mechanism and store sensitive values in `secrets.toml` or the
environment.

Bearer token example:

```toml
[mcp.servers.example]
transport = "streamable_http"
url = "https://example.com/mcp"
bearer_token_ref = "secret://mcp/example/bearerToken"
```

Matching `secrets.toml`:

```toml
[mcp.example]
bearerToken = "paste-your-token-here"
```

Static header example:

```toml
[mcp.servers.example]
transport = "streamable_http"
url = "https://example.com/mcp"

[mcp.servers.example.headers]
X-API-Key_ref = "env://EXAMPLE_MCP_API_KEY"
```

## Local stdio servers

Use `stdio` for local MCP servers started by a command on the host.

```toml
[mcp.servers.local_tools]
transport = "stdio"
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem", "/Users/example/project"]
tool_policy = "ask"
```

Environment variables for stdio servers can also use refs:

```toml
[mcp.servers.local_tools.env]
API_KEY_ref = "secret://mcp/localTools/apiKey"
```

## Tool policy

Each server can choose one policy:

- `ask`: require approval unless there is already an active grant.
- `auto`: allow tools marked by the MCP server as read-only and non-destructive;
  ask for riskier tools.
- `always_allow`: allow all tools from this server without approval.

Prefer `ask` unless you fully trust the server and the tools it exposes.

## Optional tuning

These defaults are usually fine:

```toml
[mcp]
catalog_ttl_ms = 86400000
startup_timeout_ms = 30000
tool_timeout_ms = 120000
failure_window_ms = 300000
degrade_after_consecutive_failures = 3
fail_startup_on_required = false
```

- `catalog_ttl_ms`: how long a fetched tool catalog stays fresh. The default is
  one day. During refresh, Pokoclaw can keep serving the previous catalog while
  it refreshes in the background.
- `startup_timeout_ms`: connection startup timeout per server.
- `tool_timeout_ms`: default timeout for individual MCP tool calls.
- `failure_window_ms` and `degrade_after_consecutive_failures`: control when a
  repeatedly failing server is marked degraded.
- `fail_startup_on_required`: keep this `false` for normal local use so one
  broken MCP server does not prevent Pokoclaw from starting.

You can override these globally under `[mcp]` or per server under
`[mcp.servers.<name>]`.

## Checking status

Use `/status` in the supported channel to see the configured MCP servers. The
status output shows each MCP server's name, lifecycle state, and transport, for
example:

```text
MCP：开启
- linear: ready / streamable_http
```

Possible lifecycle states include `starting`, `ready`, `failed`, `degraded`,
`refreshing`, `closing`, and `disabled`.
