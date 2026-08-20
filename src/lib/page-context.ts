import { getTemplateSrv, locationService } from '@grafana/runtime';
import { PageContext } from './protocol';

/**
 * Extracts context about the Grafana page the user is currently viewing so the
 * chat input can be prefilled with a relevant question.
 *
 * This is intentionally defensive: Grafana does not expose a stable public API
 * for reading the active dashboard/panel, so we read from the officially
 * supported `getTemplateSrv()` (time range + variables) and the URL, and
 * best-effort probe the scene context when present. Everything is optional.
 */

type SceneLike = {
  isActive?: boolean;
  state?: {
    title?: string;
    uid?: string;
  };
};

declare global {
  interface Window {
    /** Set by Grafana Scenes when a scene is active; not part of the public API. */
    __grafanaSceneContext?: SceneLike;
  }
}

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

/** Best-effort dashboard title/uid from the scene context or URL. */
function readDashboard(): { dashboardTitle?: string; dashboardUid?: string } {
  const scene = window.__grafanaSceneContext;
  const dashboardTitle = scene?.state?.title;
  const location = locationService.getLocation();
  const uidMatch = location.pathname.match(/\/d\/([^/]+)/);
  const dashboardUid = scene?.state?.uid ?? uidMatch?.[1];
  return { dashboardTitle, dashboardUid };
}

/** Alert rule uid when viewing an alert rule page. */
function readAlertUid(): string | undefined {
  const location = locationService.getLocation();
  const match = location.pathname.match(/\/alerting\/[^/]*\/?([A-Za-z0-9_-]+)?\/view/);
  return match?.[1];
}

export function extractPageContext(): PageContext {
  const { dashboardTitle, dashboardUid } = readDashboard();
  const timeRange = readTimeRange();
  const datasource = readDatasource();
  const alertUid = readAlertUid();
  const url = window.location.href;

  const variables = getTemplateSrv()
    .getVariables()
    .map((v) => v.name)
    .filter(Boolean);

  const parts: string[] = [];
  if (dashboardTitle) {
    parts.push(`dashboard "${dashboardTitle}"`);
  } else if (dashboardUid) {
    parts.push(`dashboard ${dashboardUid}`);
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
  if (variables.length > 0) {
    parts.push(`variables: ${variables.join(', ')}`);
  }

  const summary = parts.length > 0 ? `Currently viewing ${parts.join(', ')}.` : undefined;

  return {
    summary,
    dashboardTitle,
    dashboardUid,
    datasource,
    timeRange,
    url,
  };
}

/** Build a default prefilled question from the current page context. */
export function buildPrefill(ctx: PageContext): string {
  if (ctx.dashboardTitle) {
    return `Investigate what's happening on "${ctx.dashboardTitle}" for the current time range and explain any anomalies.`;
  }
  if (ctx.summary) {
    return `${ctx.summary} What should I look into?`;
  }
  return '';
}
