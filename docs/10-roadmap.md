# 10 — Roadmap & known gaps

Authoritative list of what is **not** done or is partial. Update as things land.

## Done since initial scaffold

- **End-to-end verified**: full round-trip against real Bedrock confirmed (streaming `content` deltas → `done`).
- **Token-level streaming**: loop uses `ConverseStream`; content streams token-by-token with a typewriter caret.
- **Local run + provisioning**: Grafana 13.2 via docker-compose on port 3001; TestData datasource + sample dashboard provisioned from `provisioning/`. Requires `GF_PLUGINS_FORWARD_HOST_ENV_VARS`.
- **Docked panel UI**: chat pushes the page aside (not overlay); DOM-injected top-bar trigger with FAB fallback.
- **Chat history**: client-side localStorage sessions with resume/delete.
- **Dashboard-level context**: `extractPageContext` fetches the dashboard model (title, panels, queries, datasource).
- **Context safety**: tool count (`maxTools`) and tool-result size (`capResult`) bounded.

## Not implemented

- **Mock MCP harness**: no bundled mock MCP server for CI (a real/external HTTP MCP server is still needed to exercise the tool loop).
- **Reasoning events**: `reasoning`/`status` `AgentEvent` types are defined but the backend never emits them. Wire up if Bedrock reasoning content is enabled.
- **Tool-permission gating**: all tools auto-run. No mutating-tool approval flow.
- **Panel-level context**: context is dashboard-wide; no stable API to read the single focused panel's targets from a body-mounted component.
- **Server-side sessions**: `sessionId` is informational; multi-turn relies on client-supplied `history`. No server persistence (history is browser-only).
- **Multi-provider models**: Bedrock only.
- **`tools/list` caching / pagination**: re-listed every turn; single-response assumed.
- **Non-text MCP content**: only `text` result blocks are forwarded to the model (images/resources dropped).
- **Plugin signing / distribution**: dev runs unsigned via env allowlist.
- **Tests / CI**: no unit/integration tests or CI workflow committed.

## Partial / caveats

- Top-bar trigger is **DOM-injected** (extension slots are allow-listed to internal plugins in Grafana 13); the injection anchor is markup-dependent and may need updating across Grafana versions — the FAB fallback covers misses.
- SDK pinned at v0.251.0 because latest needs Go ≥1.26.5 (local Go 1.25.7). Bump Go, then the SDK.
- Datasource detection prefers the dashboard model but reports only the first datasource on mixed dashboards.
- Single shared 60s HTTP timeout for all MCP calls; no per-tool timeout/retry.
- `react-dom/client` relies on Grafana exposing it as a shared external (present in 13.2).

## Suggested next steps (priority order)

1. Add tool-permission gating for mutating tools (surface a `tool_permission_request` in the UI).
2. Populate panel-level `PageContext` (Scenes traversal or an extension-link variant that passes panel props).
3. Add unit tests (agent loop with a fake MCP client; `chat-stream` SSE parsing; `chat-store`) + a CI workflow.
4. Provider abstraction behind the agent so non-Bedrock models can be configured.
5. Forward non-text MCP content (images/resources) to the model where supported.
