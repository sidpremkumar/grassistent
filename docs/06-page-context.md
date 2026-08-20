# 06 — Page context & prefill

`src/lib/page-context.ts`. Browser-side extraction of what the user is viewing, plus a suggested question. Backend enrichment happens separately (see [03](./03-backend.md) `enrichWithContext`).

## `PageContext` (from `lib/protocol.ts`)

```ts
type PageContext = {
  summary?: string;         // human-readable "Currently viewing ..."
  dashboardTitle?: string;
  dashboardUid?: string;
  panelTitle?: string;      // first panel title from the dashboard model
  queries?: string[];       // per-panel query summaries
  datasource?: string;
  timeRange?: { from: string; to: string };
  url?: string;
};
```

## `extractPageContext(): Promise<PageContext>`

Async, because it fetches the full dashboard model from Grafana's backend API.
Uses officially-exposed runtime APIs plus URL parsing:

- **Dashboard** (`readDashboard`, async): parses the uid from `/d/<uid>`, then
  `getBackendSrv().get('/api/dashboards/uid/<uid>')` to read the **title,
  panels, per-panel queries, and datasource** — the reliable way on Grafana 13
  Scenes dashboards (where `window.__grafanaSceneContext` isn't consistently
  exposed). Falls back to `{ dashboardUid }` on any error.
- **Explore** (`readExplore`): decodes the `panes` URL param (schemaVersion ≥ 1)
  to surface the first pane's datasource, time range, and actual queries.
- **Time range**: Explore range, else `from`/`to` query params.
- **Datasource**: dashboard model, else Explore, else `var-datasource`/`datasource`.
- **Alert**: uid parsed from `/alerting/.../<uid>/view`.
- **Variables**: `getTemplateSrv().getVariables()` names.
- **URL**: `window.location.href`.

`queries` are summarized by `summarizeQuery` (probes `expr`/`query`/`rawSql`/
`target`, else a trimmed JSON of meaningful keys).

`summary` is assembled from whichever parts exist, e.g.:
`Currently viewing dashboard "Checkout API", datasource prod-prom, time range now-1h → now, 3 queries, variables: service.`
followed by a rendered list of the queries.

Callers must `await` (or `.then()`) it — `ChatPanel` does so on mount and on new
chat. The result is shown in the **context disclosure** at the top of the panel
(`ContextDisclosure` in `ChatPanel.tsx`): when context exists it summarizes it
(dashboard, datasource, time range, queries) behind an expandable header; when
nothing is detected it explicitly reads `Agent has no page context` so the empty
case is visible rather than silent.

## `buildPrefill(ctx): string`

- If `dashboardTitle`: `Investigate what's happening on "<title>" for the current time range and explain any anomalies.`
- Else if `queries` present: `Explain what my current Explore query is doing and how to improve it ...`
- Else if `summary`: `<summary> What should I look into?`
- Else: `''` (empty; user types freely).

## How it reaches the model

1. Browser sends `pageContext` in the `ChatRequest`.
2. Backend `enrichWithContext` prepends a `[Grafana page context] ... [User question] ...` block to the user message.

This keeps prompt shaping on the backend and provider-agnostic; the frontend never hard-codes model-specific instructions.

## Gaps / not-yet-implemented

- Panel/query reading is **dashboard-wide**, not scoped to the focused panel —
  there's no stable public API to read the single focused panel's targets from a
  body-mounted context. `panelTitle` is just the first panel.
- Datasource detection prefers the dashboard model but is still coarse; a
  dashboard with mixed datasources reports the first one found.
