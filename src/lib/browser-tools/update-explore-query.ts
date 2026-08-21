import { locationService } from '@grafana/runtime';
import { BrowserTool, asString } from './types';
import { normalizeQueryObject, queryObjectFromString, resolveDatasource } from '../datasources';
import { verifyQueries } from '../query-verify';

/**
 * Edits the Explore pane the user is ALREADY looking at, by merging into the
 * existing `panes` URL state instead of replacing it (which is what
 * open_explore does). This preserves pane keys, split view, limit/tableType
 * and whatever else the agent did not explicitly touch.
 *
 * Approval policy: switching the query editor tab (queryType) or the time
 * range is free; changing the query content or the datasource requires the
 * user's confirmation.
 */

type ExplorePane = {
  datasource?: string | { uid?: string; type?: string };
  queries?: Array<Record<string, unknown>>;
  range?: { from?: string; to?: string };
} & Record<string, unknown>;

/** Parse the current `panes` URL param; undefined when not on Explore. */
function readPanes(): Record<string, ExplorePane> | undefined {
  const location = locationService.getLocation();
  if (!location.pathname.includes('/explore')) {
    return undefined;
  }
  const raw = locationService.getSearch().get('panes');
  if (!raw) {
    return undefined;
  }
  try {
    return JSON.parse(raw) as Record<string, ExplorePane>;
  } catch {
    return undefined;
  }
}

function paneDatasourceUid(pane: ExplorePane): string | undefined {
  return typeof pane.datasource === 'string' ? pane.datasource : pane.datasource?.uid;
}

/** True when the patch only moves tabs / cosmetic state, not query content. */
function isTabSwitchOnly(patch: Record<string, unknown> | undefined): boolean {
  if (!patch) {
    return true;
  }
  return Object.keys(patch).every((k) => k === 'queryType' || k === 'tableType');
}

export const updateExploreQueryTool: BrowserTool = {
  spec: {
    name: 'update_explore_query',
    description:
      'Modify the Explore pane the user is currently viewing, merging into its existing URL state ' +
      '(preserves everything you do not change). Use "queryType" alone to switch the query editor tab ' +
      '(e.g. Tempo: "traceql" = raw TraceQL editor, "traceqlSearch" = Search tab, "serviceMap" = Service ' +
      'Graph) — this needs no approval. Use "patch" to merge fields into one query (target with "refId"), ' +
      '"queries" to replace all queries (strings are mapped to the right field for the datasource type), ' +
      'or "datasourceUid" to switch datasource — these ask the user for approval. ' +
      'The result includes a server-side verification run — if it reports an error, fix and retry. ' +
      'Current pane keys, refIds and full query objects are in the page context.',
    inputSchema: {
      type: 'object',
      properties: {
        paneKey: { type: 'string', description: 'Explore pane key from the page context (default: first pane)' },
        queryType: {
          type: 'string',
          description: 'Switch the query editor tab, e.g. "traceql" | "traceqlSearch" | "serviceMap" for Tempo',
        },
        refId: { type: 'string', description: 'Target a single query by refId (default: all queries)' },
        patch: {
          type: 'object',
          description: 'Fields to shallow-merge into the targeted query object(s), e.g. {"query": "{...}"}',
        },
        queries: {
          type: 'array',
          description: 'Full replacement queries: expression strings or datasource-specific query objects',
          items: { type: ['string', 'object'] },
        },
        datasourceUid: { type: 'string', description: 'Switch the pane to another datasource (uid or name)' },
        from: { type: 'string', description: 'Optional new time range start, e.g. "now-1h"' },
        to: { type: 'string', description: 'Optional new time range end, e.g. "now"' },
      },
    },
  },
  needsConfirmation(args: { input: Record<string, unknown> }) {
    if (asString(args.input.datasourceUid) || Array.isArray(args.input.queries)) {
      return true;
    }
    const patch =
      typeof args.input.patch === 'object' && args.input.patch !== null
        ? (args.input.patch as Record<string, unknown>)
        : undefined;
    return !isTabSwitchOnly(patch);
  },
  describeAction(args: { input: Record<string, unknown> }) {
    const ds = asString(args.input.datasourceUid);
    if (ds) {
      return `Switch the Explore datasource to ${ds}`;
    }
    if (Array.isArray(args.input.queries)) {
      const n = args.input.queries.length;
      return `Replace the Explore ${n === 1 ? 'query' : `queries (${n})`}`;
    }
    return 'Update the Explore query';
  },
  async execute(args: { input: Record<string, unknown> }) {
    const panes = readPanes();
    if (!panes) {
      return {
        content: 'not on an Explore page with pane state — use open_explore to start a new Explore view',
        isError: true,
      };
    }
    const paneKey = asString(args.input.paneKey) ?? Object.keys(panes)[0];
    const pane = panes[paneKey];
    if (!pane) {
      return { content: `no Explore pane "${paneKey}" (have: ${Object.keys(panes).join(', ')})`, isError: true };
    }

    const changes: string[] = [];

    /* 1. Datasource switch. */
    const newDsRef = asString(args.input.datasourceUid);
    const previousDsUid = paneDatasourceUid(pane);
    const previousDsInfo = previousDsUid ? resolveDatasource({ uidOrName: previousDsUid }) : undefined;
    const dsInfo = resolveDatasource({ uidOrName: newDsRef ?? previousDsUid ?? '' });
    if (newDsRef) {
      if (!dsInfo) {
        return { content: `unknown datasource "${newDsRef}"`, isError: true };
      }
      pane.datasource = dsInfo.uid;
      /* Carrying the old query fields across a type change (e.g. a PromQL
       * "expr" onto Tempo) leaves Explore with a query the new datasource
       * ignores, which renders as an empty pane while every check passes. Drop
       * them unless the caller is replacing the queries anyway. */
      const typeChanged = previousDsInfo !== undefined && previousDsInfo.type !== dsInfo.type;
      const replacingQueries = Array.isArray(args.input.queries) && args.input.queries.length > 0;
      pane.queries = (pane.queries ?? []).map((q) =>
        typeChanged && !replacingQueries
          ? { refId: q.refId, datasource: { uid: dsInfo.uid, type: dsInfo.type } }
          : { ...q, datasource: { uid: dsInfo.uid, type: dsInfo.type } },
      );
      changes.push(
        `datasource → ${dsInfo.name} (${dsInfo.type})` +
          (typeChanged && !replacingQueries ? ' [incompatible query fields cleared — set a new query]' : ''),
      );
    }

    /* 2. Full query replacement. */
    if (Array.isArray(args.input.queries) && args.input.queries.length > 0) {
      const replaced: Array<Record<string, unknown>> = [];
      for (let i = 0; i < args.input.queries.length; i++) {
        const item: unknown = args.input.queries[i];
        const refId = String.fromCharCode(65 + i);
        if (typeof item === 'string' && item.length > 0) {
          const base = queryObjectFromString({ expression: item, datasourceType: dsInfo?.type });
          replaced.push({ ...base, refId });
        } else if (typeof item === 'object' && item !== null) {
          const obj = normalizeQueryObject({
            query: item as Record<string, unknown>,
            datasourceType: dsInfo?.type,
          });
          replaced.push({ ...obj, refId: asString(obj.refId) ?? refId });
        }
      }
      if (replaced.length === 0) {
        return { content: '"queries" contained no usable entries', isError: true };
      }
      pane.queries = replaced;
      changes.push(`queries replaced (${replaced.length})`);
    }

    /* 3. Patch / tab switch on targeted queries. */
    const patchInput =
      typeof args.input.patch === 'object' && args.input.patch !== null
        ? (args.input.patch as Record<string, unknown>)
        : {};
    const queryType = asString(args.input.queryType);
    const patch: Record<string, unknown> = queryType ? { ...patchInput, queryType } : patchInput;
    if (Object.keys(patch).length > 0) {
      const refId = asString(args.input.refId);
      const targets = pane.queries ?? [];
      if (targets.length === 0) {
        pane.queries = [{ refId: 'A', ...patch }];
      } else {
        let matched = false;
        pane.queries = targets.map((q) => {
          if (refId && q.refId !== refId) {
            return q;
          }
          matched = true;
          return { ...q, ...patch };
        });
        if (refId && !matched) {
          return {
            content: `no query with refId "${refId}" in pane "${paneKey}" (has: ${targets
              .map((q) => String(q.refId))
              .join(', ')})`,
            isError: true,
          };
        }
      }
      changes.push(`merged ${JSON.stringify(patch).slice(0, 200)}`);
    }

    /* 4. Time range. */
    const from = asString(args.input.from);
    const to = asString(args.input.to);
    if (from && to) {
      pane.range = { from, to };
      changes.push(`range → ${from} … ${to}`);
    }

    if (changes.length === 0) {
      return { content: 'nothing to change: pass queryType, patch, queries, datasourceUid, or from/to', isError: true };
    }

    panes[paneKey] = pane;
    locationService.partial({ panes: JSON.stringify(panes) });

    /* Verify what will actually run, attaching the pane datasource where a
     * query does not carry its own. */
    const rangeFrom = pane.range?.from ?? 'now-1h';
    const rangeTo = pane.range?.to ?? 'now';
    const dsUid = paneDatasourceUid(pane);
    const verifiable = (pane.queries ?? []).map((q, i) => ({
      ...q,
      refId: typeof q.refId === 'string' ? q.refId : String.fromCharCode(65 + i),
      datasource: q.datasource ?? (dsUid ? { uid: dsUid } : undefined),
    }));
    const verdict = await verifyQueries({ queries: verifiable, from: rangeFrom, to: rangeTo });

    return {
      content: `Explore pane "${paneKey}" updated (${changes.join('; ')}). ${verdict.summary}`,
      isError: !verdict.ok,
    };
  },
};
