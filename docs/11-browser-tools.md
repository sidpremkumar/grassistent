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
| `update_explore_query` | 1 | Merges into the existing `panes` URL state (preserves pane keys, split view, untouched fields) |
| `update_panel_query` | 2 | Walks `window.__grafanaSceneContext` to the panel's SceneQueryRunner, `setState({datasource?, queries})` + `runQueries()` — live in-place edit, unsaved |

### Why `update_panel_query` takes a `datasourceUid`

A panel's datasource lives on the **runner** (`SceneQueryRunner.state.datasource`), not on its individual queries: per-query `datasource` refs are ignored unless the panel is on `-- Mixed --`. Writing only `queries` therefore re-runs the *new* expression against the *old* datasource — which returns plausible data, passes every check, and lets the model report a datasource switch that never happened. The tool writes both, and a query-language change requires `datasourceUid` (enforced in the system prompt).

### Honest verdicts

`update_panel_query` runs two independent checks, because either can pass while the other fails:

1. **Read-back** (`describeUnappliedState`, `scene-graph.ts`) — re-reads the runner and reports every field that did not stick. `setState` is a silent write, so this is the only way to distinguish "applied" from "ignored". Any mismatch is `isError: true`.
2. **Query verdict** (`awaitRunnerVerdict`) — waits for the panel's real `PanelData` and reports the datasource error message or series/row counts. A **timeout is a failure** (`ok: false`, `UNVERIFIED`): "still Loading after 8s" cannot support a claim that the panel now shows the requested data.

`findPanel` prefers an **exact** `panel-<id>` key match, falling back to suffixed keys (`panel-3-clone-1`) only when no exact node exists — mutating an off-screen edit-mode clone is another way to produce a healthy verdict with an unchanged screen.

`update_explore_query` clears incompatible query fields when the datasource **type** changes (a PromQL `expr` carried onto Tempo renders an empty pane while every check passes) and says so in its result.

`update_panel_query` **refuses dishonest edits**: patching `expr` onto a query
that never had one (TestData, SQL, etc.) would be silently ignored by the
datasource, so the tool errors with the query's actual fields and tells the
model to level with the user (grafana-testdata is synthetic; no aggregation
exists) — unless a `datasourceUid` switch accompanies it, since the new
datasource may legitimately be expression-based. Page context includes panel ids
and `uid (type)` datasources so the model can see this coming
(see [06](./06-page-context.md)).

Tier 1 = officially supported URL-state APIs. Tier 2 = semi-private Scenes surface; structural typing + guards, clean error on drift so the model falls back to Tier 1 (`open_explore` / `open_panel_editor`).

## Failure visibility

A tool failure used to be invisible: the trace auto-collapsed the moment answer text arrived, and the model's prose ("I've updated the view…") streams **before** the tool runs. Three things close that gap:

- **Trace stays open.** `ThinkingBlock` does not auto-collapse when any step errored, renders the failing tool names in an inline banner, and expands the failing step's detail by default.
- **Errors are never dropped.** Backend `error` events and stream failures are *appended* to the answer instead of being discarded when text already streamed (the old `m.content || …`). A turn that requested browser tools but never received a `paused` token now says so explicitly rather than returning silently.
- **Failures survive the turn.** History is text-only over the wire, so `withToolOutcomes` (`use-agent-chat.ts`) folds failed tool calls into the replayed transcript — otherwise the next turn sees only the model's own false claim and reaffirms it.

Page context also prefers the **live scene's** queries over the saved dashboard model (`collectLivePanelQueries`), marking divergence as `LIVE-UNSAVED`. In-place edits are deliberately unsaved, so reading the API model alone made the agent blind to its own no-ops.

## Confirmation gate

Tools with `requiresConfirmation: true` (`update_panel_query`, `open_explore`) or a per-call `needsConfirmation` (`update_explore_query`: query/datasource changes need approval, tab and time-range switches do not) render an inline Allow / Always allow / Deny chip (`ChatPanel.tsx`, `styles.interaction`) before executing. "Always allow" is a blanket approval for all mutating tools, scoped to the chat session and persisted in localStorage (`chat-store.ts` autoAllow). A denial returns an error tool result ("The user declined this action.") so the model adapts rather than retrying.

Auto-approve only skips the **prompt** — `tool.execute` still runs. Its one real cost is that the arguments card is never shown, so the verdicts above are the only signal that an action misfired.

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
