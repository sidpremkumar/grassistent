# 08 — Configuration

## Storage model

Grafana app plugin settings split into:
- **`jsonData`** — non-secret config (region, model, MCP server list). Readable by the frontend config page.
- **`secureJsonData`** — secrets (AWS keys, per-MCP auth values). Write-only from the browser; decrypted only in the backend. The frontend sees only `secureJsonFields` booleans (whether each is set).

## `Settings` (jsonData) — `pkg/plugin/settings.go`

```go
type Settings struct {
    BedrockRegion     string            `json:"bedrockRegion"`     // default "us-east-1"
    ModelID           string            `json:"modelId"`           // default us.anthropic.claude-sonnet-4-5-20250929-v1:0
    MaxToolIterations int               `json:"maxToolIterations"` // default 12
    MaxTools          int               `json:"maxTools"`          // cap tools advertised to Bedrock (default 64; 0 = no cap)
    SystemPrompt      string            `json:"systemPrompt,omitempty"`
    MCPServers        []MCPServerConfig `json:"mcpServers"`
}

type MCPServerConfig struct {
    Name       string `json:"name"`                 // used for tool namespacing; must NOT contain "__"
    URL        string `json:"url"`                  // HTTP MCP endpoint
    AuthHeader string `json:"authHeader,omitempty"` // optional header name
}
```

`defaultSettings()` supplies defaults; `loadSettings` re-applies defaults for
empty/invalid fields.

## Config precedence (UI > env > defaults)

`loadSettings` layers configuration so the plugin can run headless:

1. UI `jsonData` / `secureJsonData` (highest).
2. Environment variables (applied only where the UI value is empty/zero).
3. Built-in defaults.

Non-secret env vars: `MCPAGENT_BEDROCK_REGION` (or `AWS_REGION`),
`MCPAGENT_MODEL_ID`, `MCPAGENT_MAX_TOOL_ITERATIONS`, `MCPAGENT_MAX_TOOLS`,
`MCPAGENT_SYSTEM_PROMPT`, `MCPAGENT_MCP_SERVERS` (JSON array of `MCPServerConfig`).
Secret env vars: `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` /
`AWS_SESSION_TOKEN`, and `MCPAGENT_MCP_SECRET_<NAME>` for a server's auth value.

> **Critical for env config**: since Grafana 12.4, plugin subprocesses do **not**
> inherit the host's environment by default. To let the backend read these env
> vars you must add the plugin to `forward_host_env_vars`
> (`GF_PLUGINS_FORWARD_HOST_ENV_VARS=mcpagent-app`). Without it, AWS creds are
> invisible to the plugin and it falls back to EC2 IMDS. See
> [09-build-and-run.md](./09-build-and-run.md).

## Secrets (secureJsonData)

Keys read by `loadSettings`:
- `awsAccessKeyId`, `awsSecretAccessKey`, `awsSessionToken` — optional static AWS creds. If access key + secret are both present, a `StaticCredentialsProvider` is used; otherwise the **default AWS credential chain** applies (env vars, IRSA, EC2/ECS role).
- `mcpSecret_<Name>` — the auth **value** for the MCP server named `<Name>`. Injected as the `AuthHeader` value when calling that server.

```go
type secrets struct {
    awsAccessKeyID     string
    awsSecretAccessKey string
    awsSessionToken    string
    mcpAuthValues      map[string]string  // name -> value, from mcpSecret_<name>
}
```

## Config page — `src/pages/ConfigPage.tsx`

Admin-only React page. Fields:
- **Bedrock**: region, model id, max tool iterations, optional system prompt (empty → `agent.DefaultSystemPrompt` from `pkg/agent/system_prompt.go`, which enables act-on-the-live-UI behavior; an operator-set prompt fully replaces it).
- **AWS credentials** (optional): access key id, secret access key — via `SecretInput` (shows "configured" once set).
- **MCP servers**: repeatable rows `{ name, url, authHeader }` + a secret `Auth value` per row stored as `mcpSecret_<name>`.

Save posts to `POST /api/plugins/mcpagent-app/settings` with `{ enabled, pinned, jsonData, secureJsonData }`, then reloads. Only non-empty secret inputs are included in `secureJsonData` (so unchanged secrets aren't overwritten with blanks).

## Recommended production auth

- **AWS**: leave static keys blank; run the plugin where the default chain works (IRSA on EKS, task role on ECS, instance role on EC2). Grant only `bedrock:InvokeModel` (+ `bedrock:Converse`) on the target model.
- **MCP**: prefer per-server bearer/API-key headers stored as `mcpSecret_<name>`.

## Never do

- Do not put secrets in `jsonData` (it's readable client-side).
- Do not commit real keys anywhere. For local dev, pass AWS creds via **environment variables** to the Grafana container (see [09](./09-build-and-run.md)), not into files.
