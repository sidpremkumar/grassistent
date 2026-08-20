# 04 — MCP client

`pkg/mcp/client.go` — a minimal MCP client over the **streamable-HTTP** transport. No external MCP SDK dependency (keeps the OSS dependency surface small). Implements only what the agent needs: `initialize`, `tools/list`, `tools/call`.

## Type

```go
type Client struct {
    name       string        // configured server name, used for tool namespacing
    endpoint   string        // MCP HTTP endpoint (e.g. https://host/mcp)
    httpClient *http.Client
    authHeader string        // optional header name (e.g. "Authorization")
    authValue  string        // optional header value (from decrypted secret)
    sessionID  string        // captured from Mcp-Session-Id response header
    nextID     int64         // JSON-RPC id counter (atomic)
}

type Tool struct {
    Name        string
    Description string
    InputSchema json.RawMessage   // JSON Schema, passed through to Bedrock ToolSpec
}
```

`NewClient(name, endpoint, authHeader, authValue, httpClient)` — `httpClient` defaults to `http.DefaultClient` if nil.

## Transport details

`call(ctx, method, params)`:
- Sends JSON-RPC 2.0 `POST` with headers:
  - `Content-Type: application/json`
  - `Accept: application/json, text/event-stream`
  - optional `<authHeader>: <authValue>`
  - `Mcp-Session-Id: <sessionID>` once known
- Captures `Mcp-Session-Id` from the response to maintain a session across calls.
- Non-2xx → error including a truncated body snippet.
- Response parsing (`readRPCResult`): if `Content-Type` contains `text/event-stream`, it scans SSE `data:` lines and uses the **last** data frame as the JSON-RPC response; otherwise reads the body as a single JSON object. Scanner buffer is sized up to 4 MiB.

## Methods

- `Initialize(ctx)` — sends `initialize` with `protocolVersion: "2025-03-26"`, empty capabilities, and `clientInfo { name: "grafana-mcp-agent", version: "0.1.0" }`. (Does **not** send a separate `notifications/initialized` — servers tested so far accept this; add if a server requires it.)
- `ListTools(ctx)` — `tools/list` → `[]Tool`.
- `CallTool(ctx, name, args)` — `tools/call` with `{ name, arguments }`. Returns `(text string, isError bool, err error)`. It concatenates all `content[]` blocks of type `text` (newline-joined). Non-text content blocks (images, resources) are currently ignored.

## Tool namespacing

The agent registers each MCP tool with Bedrock under `"<server>__<tool>"` (`agent.namespaced`). On a `tool_use`, `agent.serverOf(name)` splits back on the first `__` to find the owning client. Implication: **server names must not contain `__`**.

## Limitations / current state

- HTTP/streamable-HTTP only. No stdio transport (would require spawning processes; out of scope for a Grafana backend).
- No caching of `tools/list` — re-listed every turn (`collectTools`). Fine for small tool sets; a candidate optimization.
- No pagination handling for `tools/list` (assumes a single response).
- No handling of MCP `notifications` / server-initiated messages.
- Only `text` result content is forwarded to the model.
