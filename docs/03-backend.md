# 03 — Backend (Go)

Grafana plugin backend managed by the SDK (`grafana-plugin-sdk-go` v0.251.0). Entry: `pkg/main.go` → `app.Manage("mcpagent-app", plugin.NewApp, app.ManageOpts{})`.

## Packages

- `pkg/plugin` — app instance, settings/secrets, resource (HTTP/SSE) handlers.
- `pkg/mcp` — MCP HTTP client. See [04-mcp-client.md](./04-mcp-client.md).
- `pkg/agent` — Bedrock ConverseStream tool loop. See [05-agent-loop.md](./05-agent-loop.md).

## App instance — `pkg/plugin/app.go`

```go
type App struct {
    backend.CallResourceHandler
    settings Settings
    secrets  secrets
    bedrock  *bedrockruntime.Client
    http     *http.Client
}
```

`NewApp(ctx, appSettings)` (the `instancemgmt` factory):
1. `loadSettings(appSettings)` → `Settings` + `secrets` (see [08](./08-config.md)).
2. Builds an AWS config with `WithRegion(settings.BedrockRegion)`. If static AWS keys are present in secrets, uses `StaticCredentialsProvider`; otherwise the **default AWS credential chain** (env, IRSA, instance role).
3. Creates `bedrockruntime.NewFromConfig(cfg)` and a 60s `http.Client`.
4. Installs the resource handler (`newResourceHandler(app)`).

Grafana creates one `App` per plugin instance and reuses it; `Dispose()` is a no-op.

`buildClients()` — constructs `[]*mcp.Client` from `settings.MCPServers`, injecting each server's decrypted auth value (`secrets.mcpAuthValues[name]`).

`newAgent()` — wires Bedrock + MCP clients + model/systemPrompt/maxIterations/maxTools into an `agent.Agent`. **A fresh agent is built per request** (cheap; clients are re-initialized each turn).

## Resource handler — `pkg/plugin/resources.go`

Mux (via `httpadapter.New`):
- `POST /chat` — the streaming chat turn (below).
- `GET /health` — returns `{"status":"ok"}`.

Grafana exposes these at `/api/plugins/mcpagent-app/resources/<path>`.

### `handleChat` (SSE)

1. Requires `POST`; decodes `chatRequest` `{ sessionId, message, history[], pageContext, browserTools[], continuation, toolResults[] }`.
2. Rejects the request with 400 only when **both** `message` and `continuation` are empty.
3. Requires the `http.ResponseWriter` to implement `http.Flusher`.
4. Sets SSE headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`, `X-Accel-Buffering: no`; writes 200 and flushes.
5. `emit` closure: `fmt.Fprintf(w, "data: %s\n\n", json(ev))` + `flusher.Flush()` per `agent.Event`.
6. **Continuation branch**: when `continuation` is set, builds a post-action context text (`"[Grafana page context observed after the browser actions]" + contextBody(pageContext)`) and calls `a.newAgent().Continue(ctx, continuation, toolResults, browserTools, contextText, emit)` — `message`/`history` are ignored. See [11-browser-tools.md](./11-browser-tools.md).
7. Otherwise: `message = enrichWithContext(req.Message, req.PageContext)` then `a.newAgent().Run(r.Context(), message, req.History, req.BrowserTools, emit)`.

The default system prompt (`agent.DefaultSystemPrompt`, `pkg/agent/system_prompt.go`) applies when `Settings.SystemPrompt` is empty (`newAgent`).

`enrichWithContext` builds a preamble:

```
[Grafana page context]
<summary>
Dashboard: <..>
Panel: <..>
Datasource: <..>
Query: <..>            (repeated)
Time range: <from> to <to>
URL: <..>

[User question]
<message>
```

Only non-empty fields are included. If `pageContext` is nil, the raw message is used.

## Settings/secrets — `pkg/plugin/settings.go`

See [08-config.md](./08-config.md) for the full shape and key names.

## Build

```bash
GOOS=linux GOARCH=amd64 go build -o dist/gpx_mcpagent_linux_amd64 ./pkg
GOOS=linux GOARCH=arm64 go build -o dist/gpx_mcpagent_linux_arm64 ./pkg
# or the SDK's mage target (needs Go >= the SDK's floor):
#   go run mage.go   (Magefile.go imports the SDK build targets)
```

`plugin.json` `executable: "gpx_mcpagent"` — Grafana appends `_<os>_<arch>` and picks the matching binary.

> SDK version note: `go get -u` wants v0.296+ which requires Go ≥1.26.5. Local Go is 1.25.7, so the module stays at **v0.251.0**. Bumping the SDK requires upgrading Go first.
