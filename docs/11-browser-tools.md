# 11 — Browser tools (live UI agency)

The agent can act on the **live Grafana page the user is viewing** — not just answer. Browser tools execute in the user's browser tab with the user's own Grafana session; the backend stays UI-agnostic and never knows what the tools do.

## Architecture: pause / execute / continue

The Bedrock loop lives in the Go backend, but browser tools can only run in the page — and may block on a human for minutes (`ask_user`, confirmations). Rather than holding the SSE stream open, the turn is **paused and resumed statelessly**:

1. Frontend sends `ChatRequest.browserTools` (manifest of name/description/inputSchema) with every request. Backend merges them into the Bedrock tool config namespaced `browser__<name>` (`pkg/agent/agent.go collectTools`), appended **after** the `MaxTools` cap so they are never dropped.
2. When the model calls a `browser__*` tool, the loop:
   - executes any server-side MCP tools requested in the same turn immediately,
   - emits one `browser_tool_call` event per browser tool,
   - serializes the in-flight conversation into an opaque **continuation token** (owned message repr → JSON → gzip → base64url, `pkg/agent/continuation.go`),
   - emits `{ type: "paused", continuation }` and closes the stream.
3. Frontend (`use-agent-chat.ts runStream`) executes the tools via `src/lib/browser-tools/registry.ts executeBrowserTool`, waits ~600ms for the page to settle, re-runs `extractPageContext()`, and POSTs `/chat` again with `{ continuation, toolResults, browserTools, pageContext }`.
4. Backend `Agent.Continue` (`pkg/agent/agent.go`) rehydrates the messages, appends one `toolResult` per pending id (missing ids become error results — Bedrock requires a result for every `toolUse`), appends the refreshed page context as a text block (**perception-action loop**: the model observes the effect of its own actions), and resumes the loop at the saved iteration index.
5. Repeat until a turn ends without a pause. Frontend caps rounds at `MAX_CONTINUATIONS = 12`; backend caps total iterations at `MaxToolIterations` (carried across pauses via `continuationState.Iter`).

## Tool surface (`src/lib/browser-tools/`)

| Tool | Tier | Mechanism |
| --- | --- | --- |
| `set_time_range` | 1 | `locationService.partial({from,to})` |
| `set_variable` | 1 | `locationService.partial({"var-<name>": value})` |
| `navigate` | 1 | `locationService.push(path)` — relative paths only |
| `open_explore` | 1 | Builds `panes` JSON URL param (schemaVersion 1); agent-composed queries run live |
| `open_panel_editor` | 1 | `locationService.partial({editPanel: id})` |
| `refresh` | 1 | `getAppEvents().publish(new RefreshEvent())` |
| `ask_user` | — | Inline question chips in chat; the user's click is the tool result |
| `update_panel_query` | 2 | Walks `window.__grafanaSceneContext` to the panel's SceneQueryRunner, `setState({queries})` + `runQueries()` — live in-place edit, unsaved |

`update_panel_query` **refuses dishonest edits**: patching `expr` onto a query
that never had one (TestData, SQL, etc.) would be silently ignored by the
datasource, so the tool errors with the query's actual fields and tells the
model to level with the user (grafana-testdata is synthetic; no aggregation
exists). Page context includes panel ids and `uid (type)` datasources so the
model can see this coming (see [06](./06-page-context.md)).

Tier 1 = officially supported URL-state APIs. Tier 2 = semi-private Scenes surface; structural typing + guards, clean error on drift so the model falls back to Tier 1 (`open_explore` / `open_panel_editor`).

## Confirmation gate

Tools with `requiresConfirmation: true` (currently `update_panel_query`) render an inline Allow / Always allow / Deny chip (`ChatPanel.tsx`, `styles.interaction`) before executing. "Always allow" is scoped to the hook instance (`autoAllowRef`). A denial returns an error tool result ("The user declined this action.") so the model adapts rather than retrying.

## Interaction plumbing

`BrowserToolContext` (`src/lib/browser-tools/types.ts`) provides `promptUser` and `confirm`, both implemented in `use-agent-chat.ts` as promises resolved by the chat panel's chips (`interaction` state + `respond`/`allowAlways`). `cancel()` resolves any pending interaction with `"cancelled"` so an aborted turn unwinds.

## Adding a tool

1. Create `src/lib/browser-tools/<name>.ts` exporting a `BrowserTool` (spec + `execute`; set `requiresConfirmation` and `describeAction` for mutating tools).
2. Import and append it in `registry.ts`.
3. Nothing backend-side: the manifest is advertised per-request.

## Security notes

- Tools run with the user's own Grafana session; no privilege escalation is possible.
- `navigate` rejects non-relative paths, so the model cannot send the user off-site.
- The continuation token is opaque client-held state (gzip'd conversation). It is not signed; tampering is equivalent to the user prompt-injecting themselves. Cap: 8 MiB on decode.
