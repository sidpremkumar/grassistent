# 10 — Roadmap & known gaps

Authoritative list of what is **not** done or is partial. Update as things land.

## Done since initial scaffold

- **End-to-end verified**: full round-trip against real Bedrock confirmed (streaming `content` deltas → `done`).
- **Token-level streaming**: loop uses `ConverseStream`; content streams token-by-token with a typewriter caret.
- **Local run + provisioning**: Grafana 13.2 via docker-compose on port 3001; TestData + a real self-scraping Prometheus (`local-prom`, host port 9091) + sample dashboard (2 TestData panels, 1 real PromQL panel) provisioned from `provisioning/`. Requires `GF_PLUGINS_FORWARD_HOST_ENV_VARS`.
- **Docked panel UI**: chat pushes the page aside (not overlay); DOM-injected top-bar trigger with FAB fallback.
- **Chat history**: client-side localStorage sessions with resume/delete.
- **Dashboard-level context**: `extractPageContext` fetches the dashboard model (title, panels + ids, queries, datasource as `uid (type)`); mount retry + re-extract on URL change; suggestion chips instead of pre-seeded input.
- **Model-generated suggestions**: `/resources/suggestions` + `Agent.Suggest` (tool-less `Converse`) turn the last ~10 messages + page context + user "custom context" into 3–4 follow-up chips, replacing the old static `buildPrefill` string. Debounced, idle-only, abort-on-supersede; failures degrade to no chips. See [13-suggestions.md](./13-suggestions.md).
- **Browser tools (live UI agency)**: pause/continue loop with continuation tokens; Tier 1 URL-state tools + Tier 2 `update_panel_query` (live scene mutation, honest failure on non-expr datasources) + `ask_user`; confirmation gate (Allow / Always allow / Deny) for mutating tools; post-action page-context observation. E2E verified against real Bedrock. See [11-browser-tools.md](./11-browser-tools.md).
- **Default system prompt**: act-don't-instruct guidance, datasource-specific query fields, testdata honesty (`pkg/agent/system_prompt.go`; operator override still wins).
- **Context safety**: tool count (`maxTools`) and tool-result size (`capResult`) bounded; browser tools exempt from `maxTools` cap; continuation rounds capped both sides.

## Not implemented

- **Mock MCP harness**: no bundled mock MCP server for CI (a real/external HTTP MCP server is still needed to exercise the tool loop).
- **Reasoning events**: `reasoning`/`status` `AgentEvent` types are defined but the backend never emits them for model reasoning. Wire up if Bedrock reasoning content is enabled.
- **MCP tool-permission gating**: MCP tools auto-run (browser mutating tools *are* confirm-gated).
- **Highlight/guide overlay** (browser tools Tier 3): spotlight + step-by-step element guidance not built.
- **Panel-level context**: context is dashboard-wide; no stable API to read the single focused panel's targets from a body-mounted component.
- **Server-side sessions**: `sessionId` is informational; multi-turn relies on client-supplied `history`. No server persistence (history is browser-only). Continuation tokens are client-held, not server state.
- **Multi-provider models**: Bedrock only.
- **`tools/list` caching / pagination**: re-listed every turn (including on every continuation resume); single-response assumed.
- **Non-text MCP content**: only `text` result blocks are forwarded to the model (images/resources dropped).
- **Plugin signing / distribution**: dev runs unsigned via env allowlist.
- **Suggestion caching / evaluation**: suggestions are regenerated on every settle and navigation (no cache), and nothing asserts their usefulness beyond shape parsing. The user's custom context steers suggestions only — it is not injected into the chat turn itself.
- **Tests / CI**: Go unit tests for the continuation codec and the suggestion parser only; no frontend tests or CI workflow committed.

## Partial / caveats

- Top-bar trigger is **DOM-injected** (extension slots are allow-listed to internal plugins in Grafana 13); the injection anchor is markup-dependent and may need updating across Grafana versions — the FAB fallback covers misses.
- SDK pinned at v0.251.0 because latest needs Go ≥1.26.5 (local Go 1.25.7). Bump Go, then the SDK.
- Datasource detection prefers the dashboard model but reports only the first datasource on mixed dashboards.
- Single shared 60s HTTP timeout for all MCP calls; no per-tool timeout/retry.
- `react-dom/client` relies on Grafana exposing it as a shared external (present in 13.2).

## Suggested next steps (priority order)

1. Tier 3 browser tools: highlight/spotlight overlay for guided walkthroughs (`@grafana/e2e-selectors` anchors).
2. MCP tool-permission gating (extend the browser-tool confirm chip to MCP mutating tools).
3. Populate panel-level `PageContext` (Scenes traversal or an extension-link variant that passes panel props).
4. Add unit tests (agent loop with a fake MCP client; `chat-stream` SSE parsing; browser-tool registry; `chat-store`) + a CI workflow.
5. Provider abstraction behind the agent so non-Bedrock models can be configured.
6. Forward non-text MCP content (images/resources) to the model where supported.
