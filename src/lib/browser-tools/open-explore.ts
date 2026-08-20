import { locationService } from '@grafana/runtime';
import { BrowserTool, asString } from './types';

/**
 * Opens Explore with agent-composed queries, live on the user's screen. This
 * is the most powerful Tier-1 tool: Explore state is entirely URL-driven
 * (`panes` JSON param, schemaVersion 1), so it works on any Grafana 10+
 * without touching private APIs.
 */

type ExplorePaneQuery = Record<string, unknown> & { refId: string };

function toQueryObjects(raw: unknown, datasourceUid: string): ExplorePaneQuery[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) {
    return undefined;
  }
  const queries: ExplorePaneQuery[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item: unknown = raw[i];
    const refId = String.fromCharCode(65 + i); // A, B, C...
    if (typeof item === 'string' && item.length > 0) {
      /* Bare string = the common case: a PromQL/LogQL-style expression. */
      queries.push({ refId, expr: item, datasource: { uid: datasourceUid } });
    } else if (typeof item === 'object' && item !== null) {
      const obj = item as Record<string, unknown>;
      queries.push({ ...obj, refId: asString(obj.refId) ?? refId, datasource: obj.datasource ?? { uid: datasourceUid } });
    }
  }
  return queries.length > 0 ? queries : undefined;
}

export const openExploreTool: BrowserTool = {
  spec: {
    name: 'open_explore',
    description:
      'Open Grafana Explore with one or more queries you compose, running live against a datasource. ' +
      'Use this to show the user a modified or new query (e.g. rewriting a panel query with different ' +
      'aggregation). "queries" items are either expression strings (Prometheus/Loki-style "expr") or full ' +
      'datasource-specific query objects (e.g. {"rawSql": "..."} for SQL datasources).',
    inputSchema: {
      type: 'object',
      properties: {
        datasourceUid: { type: 'string', description: 'UID (or name) of the datasource to query' },
        queries: {
          type: 'array',
          description: 'Query expression strings or datasource-specific query objects',
          items: { type: ['string', 'object'] },
        },
        from: { type: 'string', description: 'Optional time range start, e.g. "now-1h"' },
        to: { type: 'string', description: 'Optional time range end, e.g. "now"' },
      },
      required: ['datasourceUid', 'queries'],
    },
  },
  async execute(args: { input: Record<string, unknown> }) {
    const datasourceUid = asString(args.input.datasourceUid);
    if (!datasourceUid) {
      return { content: '"datasourceUid" is required', isError: true };
    }
    const queries = toQueryObjects(args.input.queries, datasourceUid);
    if (!queries) {
      return { content: '"queries" must be a non-empty array of strings or query objects', isError: true };
    }
    const from = asString(args.input.from) ?? 'now-1h';
    const to = asString(args.input.to) ?? 'now';

    const pane = {
      datasource: datasourceUid,
      queries,
      range: { from, to },
    };
    const panes = encodeURIComponent(JSON.stringify({ agent: pane }));
    locationService.push(`/explore?schemaVersion=1&panes=${panes}`);
    return {
      content: `Opened Explore with ${queries.length} quer${queries.length === 1 ? 'y' : 'ies'} against ${datasourceUid}, range ${from} → ${to}.`,
    };
  },
};
