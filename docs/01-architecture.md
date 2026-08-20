# 01 — Architecture

## Topology

Two artifacts ship inside one plugin bundle:

1. **Frontend module** (`dist/module.js`): AMD-bundled React app loaded by the Grafana host. Uses the host-provided `react`, `react-dom`, `@grafana/{data,runtime,ui}`, `@emotion/css` (declared as webpack `externals`).
2. **Backend binary** (`dist/gpx_mcpagent_<os>_<arch>`): a Grafana plugin backend process managed over hashicorp go-plugin (gRPC) by Grafana. Declared in `plugin.json` via `"backend": true` + `"executable": "gpx_mcpagent"`.

There is **no separate service to deploy** — the agent loop lives in the backend binary that Grafana already manages. This is the key design choice vs. a Node sidecar: single artifact, best open-source distribution story, at the cost of writing the tool loop in Go (the Claude Agent SDK is not available for Go).

## Trust boundary

```
Browser (untrusted)          Grafana server (trusted)              External
┌───────────────┐            ┌──────────────────────────┐         ┌──────────────┐
│ module.js     │  same-     │ plugin backend (Go)      │  HTTPS  │ Bedrock      │
│ chat UI       │  origin    │  - holds AWS creds       │────────▶│(ConverseStream)│
│ NO secrets    │  fetch     │  - holds MCP auth values │         └──────────────┘
│               │──SSE POST─▶│  - runs agent loop       │  HTTP   ┌──────────────┐
└───────────────┘            └──────────────────────────┘────────▶│ MCP servers  │
                                                                   └──────────────┘
```

- The browser only ever calls the **same-origin** resource route `/api/plugins/mcpagent-app/resources/chat`, authenticated by the user's existing Grafana session cookie. No API keys or MCP secrets are shipped to the browser.
- Secrets (AWS keys, per-MCP auth header values) live in Grafana's encrypted `secureJsonData` and are only decrypted inside the backend process (`backend.AppInstanceSettings.DecryptedSecureJSONData`).

## Data flow (detailed)

1. **Context capture** (browser): `extractPageContext()` (async) reads `getTemplateSrv()` (variables/time), `locationService` (URL), and fetches the dashboard model via `getBackendSrv().get('/api/dashboards/uid/<uid>')` for title/panels/queries/datasource (plus Explore pane state from the URL). Produces a `PageContext`.
2. **Prefill** (browser): `buildPrefill(ctx)` derives a suggested question string; user may edit.
3. **Send** (browser): `useAgentChat.send()` builds a `ChatRequest` `{ sessionId, message, history, pageContext }` and calls `streamChat()`.
4. **Enrichment** (backend): `enrichWithContext()` prepends a compact `[Grafana page context] ... [User question] ...` preamble to the message. This keeps provider-specific prompt shaping on the backend, not hard-coded in the UI.
5. **Tool discovery** (backend): `agent.collectTools()` initializes each configured MCP client and lists its tools, building a Bedrock `ToolConfiguration`. Tool names are namespaced `"<server>__<tool>"` to avoid collisions.
6. **Loop** (backend): `bedrock.ConverseStream` runs; text deltas stream out as `content` events token-by-token; `tool_use` blocks trigger `mcp.CallTool`, whose (size-capped) results feed the next turn. Bounded by `MaxToolIterations`; tool count bounded by `MaxTools`.
7. **Stream** (both): each `agent.Event` is JSON-serialized into an SSE `data:` frame; the browser parses frames in `chat-stream.ts` and patches React state in `use-agent-chat.ts`.

## Why SSE (not WebSocket)

The plugin backend resource interface is request/response HTTP (`backend.CallResourceHandler` via `httpadapter`). SSE fits naturally: a single POST whose response body streams `data:` frames until `done`/`error`. No extra socket server, no cross-origin handshake, session auth is inherited.

## Failure semantics

- Any backend error emits an `{type:"error"}` event; the loop returns. The frontend renders the error text in the assistant bubble and clears the streaming state.
- The frontend also has `onError`/`onDone` guards in `streamChat()` so the UI never hangs.
- Client aborts (`AbortController`) are treated as a clean stop.
