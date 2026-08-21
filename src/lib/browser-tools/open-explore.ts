import { locationService } from '@grafana/runtime';
import { BrowserTool, asString } from './types';
import { normalizeQueryObject, queryObjectFromString, resolveDatasource } from '../datasources';
import { verifyQueries } from '../query-verify';

/**
 * Opens Explore with agent-composed queries, live on the user's screen. This
 * is the most powerful Tier-1 tool: Explore state is entirely URL-driven
 * (`panes` JSON param, schemaVersion 1), so it works on any Grafana 10+
 * without touching private APIs.
 *
 * Query shapes are datasource-type-aware: bare strings become {expr} for
 * Prometheus/Loki, {query, queryType: "traceql"} for Tempo, {rawSql} for SQL.
 * After pushing the URL, the composed queries are executed once through
 * /api/ds/query so the tool result carries the datasource's real verdict
 * (frames or the error message) instead of blind optimism.
 */

type ExplorePaneQuery = Record<string, unknown> & { refId: string };

function toQueryObjects(args: {
  raw: unknown;
  datasourceUid: string;
  datasourceType: string | undefined;
}): ExplorePaneQuery[] | undefined {
  if (!Array.isArray(args.raw) || args.raw.length === 0) {
    return undefined;
  }
  const queries: ExplorePaneQuery[] = [];
  for (let i = 0; i < args.raw.length; i++) {
    const item: unknown = args.raw[i];
    const refId = String.fromCharCode(65 + i); // A, B, C...
    if (typeof item === 'string' && item.length > 0) {
      const base = queryObjectFromString({ expression: item, datasourceType: args.datasourceType });
      queries.push({ ...base, refId, datasource: { uid: args.datasourceUid } });
    } else if (typeof item === 'object' && item !== null) {
      const obj = normalizeQueryObject({
        query: item as Record<string, unknown>,
        datasourceType: args.datasourceType,
      });
      queries.push({
        ...obj,
        refId: asString(obj.refId) ?? refId,
        datasource: obj.datasource ?? { uid: args.datasourceUid },
      });
    }
  }
  return queries.length > 0 ? queries : undefined;
}

export const openExploreTool: BrowserTool = {
  spec: {
    name: 'open_explore',
    description:
      'Open Grafana Explore with one or more queries you compose, running live against a datasource. ' +
      'Use this to show the user a modified or new query. "queries" items are either expression strings ' +
      '(PromQL/LogQL/TraceQL/SQL — mapped to the right field for the datasource type automatically) or ' +
      'full datasource-specific query objects. Tempo query objects use {"query": "<TraceQL>", "queryType": ' +
      '"traceql"} or {"queryType": "traceqlSearch", "filters": [...]}. The result includes a server-side ' +
      'verification run of the queries — if it reports an error, fix the query and retry. ' +
      'To modify what is ALREADY on the Explore screen, prefer update_explore_query.',
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
  /* Composes new queries against a datasource — always a user-approved change. */
  requiresConfirmation: true,
  describeAction(args: { input: Record<string, unknown> }) {
    const ds = asString(args.input.datasourceUid) ?? '?';
    const queries = Array.isArray(args.input.queries) ? args.input.queries : [];
    const first = queries[0];
    const preview =
      typeof first === 'string' ? first : first ? JSON.stringify(first).slice(0, 120) : '';
    return `Open Explore against ${ds} with: ${preview}${queries.length > 1 ? ` (+${queries.length - 1} more)` : ''}`;
  },
  async execute(args: { input: Record<string, unknown> }) {
    const datasourceUid = asString(args.input.datasourceUid);
    if (!datasourceUid) {
      return { content: '"datasourceUid" is required', isError: true };
    }
    const dsInfo = resolveDatasource({ uidOrName: datasourceUid });
    const queries = toQueryObjects({
      raw: args.input.queries,
      datasourceUid: dsInfo?.uid ?? datasourceUid,
      datasourceType: dsInfo?.type,
    });
    if (!queries) {
      return { content: '"queries" must be a non-empty array of strings or query objects', isError: true };
    }
    const from = asString(args.input.from) ?? 'now-1h';
    const to = asString(args.input.to) ?? 'now';

    const pane = {
      datasource: dsInfo?.uid ?? datasourceUid,
      queries,
      range: { from, to },
    };
    const panes = encodeURIComponent(JSON.stringify({ agent: pane }));
    locationService.push(`/explore?schemaVersion=1&panes=${panes}`);

    const verdict = await verifyQueries({ queries, from, to });
    const opened = `Opened Explore with ${queries.length} quer${queries.length === 1 ? 'y' : 'ies'} against ${
      dsInfo ? `${dsInfo.name} (${dsInfo.type})` : datasourceUid
    }, range ${from} → ${to}.`;
    return {
      content: `${opened} ${verdict.summary}`,
      isError: !verdict.ok,
    };
  },
};
