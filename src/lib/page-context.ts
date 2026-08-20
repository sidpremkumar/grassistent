import { getBackendSrv, getTemplateSrv, locationService } from '@grafana/runtime';
import { PageContext } from './protocol';

/**
 * Extracts context about the Grafana page the user is currently viewing so the
 * chat input can be prefilled with a relevant question and the agent knows what
 * is on screen.
 *
 * We read from officially supported APIs: `getTemplateSrv()` for time range and
 * variables, `getBackendSrv()` for the dashboard model, and the URL for Explore
 * pane state. Everything is optional and best-effort.
 */

/** Read the active time range via the supported TemplateSrv API. */
function readTimeRange(): PageContext['timeRange'] {
  const search = locationService.getSearch();
  const from = search.get('from');
  const to = search.get('to');
  if (from && to) {
    return { from, to };
  }
  return undefined;
}

/** Read datasource + query hints from URL state (Explore) or variables. */
function readDatasource(): string | undefined {
  const search = locationService.getSearch();
  const ds = search.get('var-datasource') ?? search.get('datasource');
  return ds ?? undefined;
}

/** Dashboard uid parsed from the URL (works for both classic and Scenes routes). */
function readDashboardUid(): string | undefined {
  const location = locationService.getLocation();
  return location.pathname.match(/\/d\/([^/]+)/)?.[1];
}

/** Minimal shape of the panels we read from the dashboard API response. */
type DashboardPanel = {
  id?: number;
  title?: string;
  type?: string;
  datasource?: string | { uid?: string; type?: string };
  targets?: Array<Record<string, unknown>>;
};

type DashboardModel = {
  dashboard?: {
    title?: string;
    uid?: string;
    panels?: DashboardPanel[];
  };
};

/**
 * Fetches the full dashboard model from Grafana's backend API. This is the
 * reliable way to know the title, panels, and queries on a Grafana 13 Scenes
 * dashboard, where `window.__grafanaSceneContext` is not consistently exposed.
 * Returns undefined when not on a dashboard or on any failure.
 */
async function readDashboard(): Promise<{
  dashboardTitle?: string;
  dashboardUid?: string;
  datasource?: string;
  queries?: string[];
  panelTitles?: string[];
}> {
  const uid = readDashboardUid();
  if (!uid) {
    return {};
  }
  try {
    const model = await getBackendSrv().get<DashboardModel>(`/api/dashboards/uid/${uid}`);
    const dash = model?.dashboard;
    if (!dash) {
      return { dashboardUid: uid };
    }
    const panels = (dash.panels ?? []).filter((p) => p.type !== 'row');
    /* Include the numeric panel id: browser tools (update_panel_query,
     * open_panel_editor) address panels by id. */
    const panelTitles = panels
      .filter((p) => Boolean(p.title))
      .map((p) => (p.id !== undefined ? `${p.title} (id ${p.id})` : `${p.title}`));

    const queries: string[] = [];
    let datasource: string | undefined;
    for (const p of panels) {
      const ds = describeDatasource(p.datasource);
      if (ds && !datasource) {
        datasource = ds;
      }
      for (const t of p.targets ?? []) {
        const q = summarizeQuery(t);
        if (q) {
          const label = p.title ? `[${p.title}${p.id !== undefined ? ` id=${p.id}` : ''}] ` : '';
          queries.push(`${label}${q}`);
        }
      }
    }

    return {
      dashboardTitle: dash.title,
      dashboardUid: dash.uid ?? uid,
      datasource,
      queries,
      panelTitles,
    };
  } catch {
    return { dashboardUid: uid };
  }
}

/** "uid (type)" so the agent can recognize e.g. testdata datasources. */
function describeDatasource(ds: DashboardPanel['datasource']): string | undefined {
  if (!ds) {
    return undefined;
  }
  if (typeof ds === 'string') {
    return ds;
  }
  if (ds.uid && ds.type) {
    return `${ds.uid} (${ds.type})`;
  }
  return ds.uid ?? ds.type;
}

/** Alert rule uid when viewing an alert rule page. */
function readAlertUid(): string | undefined {
  const location = locationService.getLocation();
  const match = location.pathname.match(/\/alerting\/[^/]*\/?([A-Za-z0-9_-]+)?\/view/);
  return match?.[1];
}

/** A single Explore pane's decoded state (subset we care about). */
type ExplorePaneState = {
  datasource?: string | { uid?: string; type?: string };
  queries?: Array<Record<string, unknown>>;
  range?: { from?: string; to?: string };
};

/**
 * Explore encodes each pane's state as JSON in the `panes` URL param
 * (schemaVersion >= 1). We read the first pane to surface its datasource,
 * time range, and the actual queries the user is running, so the agent can
 * reason about what's on screen instead of asking the user to describe it.
 */
function readExplore(): {
  datasource?: string;
  queries?: string[];
  timeRange?: PageContext['timeRange'];
} {
  const location = locationService.getLocation();
  if (!location.pathname.includes('/explore')) {
    return {};
  }
  const panesRaw = locationService.getSearch().get('panes');
  if (!panesRaw) {
    return {};
  }
  let panes: Record<string, ExplorePaneState>;
  try {
    panes = JSON.parse(panesRaw) as Record<string, ExplorePaneState>;
  } catch {
    return {};
  }
  const first = Object.values(panes)[0];
  if (!first) {
    return {};
  }

  const datasource =
    typeof first.datasource === 'string'
      ? first.datasource
      : first.datasource?.uid ?? first.datasource?.type;

  const queries = (first.queries ?? [])
    .map((q) => summarizeQuery(q))
    .filter((s): s is string => Boolean(s));

  const timeRange =
    first.range?.from && first.range?.to ? { from: first.range.from, to: first.range.to } : undefined;

  return { datasource, queries, timeRange };
}

/**
 * Reduces a raw Explore query object to a compact human/agent-readable string.
 * Query shapes vary per datasource, so we probe the common expression fields
 * and fall back to a trimmed JSON of the meaningful keys.
 */
function summarizeQuery(q: Record<string, unknown>): string | undefined {
  const expr =
    (typeof q.expr === 'string' && q.expr) ||
    (typeof q.query === 'string' && q.query) ||
    (typeof q.rawSql === 'string' && q.rawSql) ||
    (typeof q.target === 'string' && q.target);
  if (expr) {
    return expr;
  }
  const omit = new Set(['refId', 'datasource', 'key', 'hide']);
  const rest = Object.fromEntries(Object.entries(q).filter(([k]) => !omit.has(k)));
  const json = JSON.stringify(rest);
  if (!json || json === '{}') {
    return undefined;
  }
  return json.length > 300 ? `${json.slice(0, 300)}…` : json;
}

export async function extractPageContext(): Promise<PageContext> {
  const dash = await readDashboard();
  const explore = readExplore();
  const timeRange = explore.timeRange ?? readTimeRange();
  const datasource = dash.datasource ?? explore.datasource ?? readDatasource();
  const queries = dash.queries?.length ? dash.queries : explore.queries ?? [];
  const alertUid = readAlertUid();
  const url = window.location.href;
  const isExplore = locationService.getLocation().pathname.includes('/explore');

  const variables = getTemplateSrv()
    .getVariables()
    .map((v) => v.name)
    .filter(Boolean);

  const parts: string[] = [];
  if (dash.dashboardTitle) {
    parts.push(`dashboard "${dash.dashboardTitle}"`);
  } else if (dash.dashboardUid) {
    parts.push(`dashboard ${dash.dashboardUid}`);
  } else if (isExplore) {
    parts.push('the Explore view');
  }
  if (alertUid) {
    parts.push(`alert rule ${alertUid}`);
  }
  if (datasource) {
    parts.push(`datasource ${datasource}`);
  }
  if (timeRange) {
    parts.push(`time range ${timeRange.from} \u2192 ${timeRange.to}`);
  }
  if (dash.panelTitles && dash.panelTitles.length > 0) {
    parts.push(`panels: ${dash.panelTitles.join(', ')}`);
  }
  if (variables.length > 0) {
    parts.push(`variables: ${variables.join(', ')}`);
  }

  let summary = parts.length > 0 ? `Currently viewing ${parts.join(', ')}.` : undefined;
  if (queries.length > 0) {
    const rendered = queries.map((q, i) => `  ${i + 1}. ${q}`).join('\n');
    summary = `${summary ?? ''}\nQueries:\n${rendered}`.trim();
  }

  return {
    summary,
    dashboardTitle: dash.dashboardTitle,
    dashboardUid: dash.dashboardUid,
    panelTitle: dash.panelTitles?.[0],
    datasource,
    queries: queries.length > 0 ? queries : undefined,
    timeRange,
    url,
  };
}

/** True when the extracted context actually describes something on screen. */
export function hasPageContext(ctx: PageContext): boolean {
  return Boolean(
    ctx.dashboardTitle ||
      ctx.dashboardUid ||
      ctx.panelTitle ||
      ctx.datasource ||
      (ctx.queries && ctx.queries.length > 0) ||
      ctx.timeRange,
  );
}

/** Build a default prefilled question from the current page context. */
export function buildPrefill(ctx: PageContext): string {
  if (ctx.dashboardTitle) {
    return `Investigate what's happening on "${ctx.dashboardTitle}" for the current time range and explain any anomalies.`;
  }
  if (ctx.queries && ctx.queries.length > 0) {
    return `Explain what my current Explore query is doing and how to improve it for the current time range.`;
  }
  if (ctx.summary) {
    return `${ctx.summary}\n\nWhat should I look into?`;
  }
  return '';
}