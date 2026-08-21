import { BrowserTool, asNumber, asString } from './types';
import {
  awaitRunnerVerdict,
  describeUnappliedState,
  findPanel,
  findQueryRunner,
  runnerDatasourceUid,
  sceneRoot,
} from '../scene-graph';
import { normalizeQueryObject, queryObjectFromString, resolveDatasource } from '../datasources';

/**
 * Tier-2 (best-effort) tool: edits a panel's queries (and optionally its
 * datasource) *in place* on the live Scenes dashboard — no save, no reload; the
 * panel re-runs immediately.
 *
 * Two independent checks run afterwards, because either can pass while the
 * other fails:
 *
 *  1. **Read-back** — Scenes silently ignores state a node does not own, so we
 *     re-read the runner and report every field that did not stick. This is what
 *     catches the "agent claims it switched datasource, screen never changed"
 *     class of bug.
 *  2. **Query verdict** — we wait for the panel's real PanelData so a datasource
 *     error or empty result is reported rather than assumed successful.
 */

export const updatePanelQueryTool: BrowserTool = {
  spec: {
    name: 'update_panel_query',
    description:
      'Edit the queries and/or datasource of a panel on the dashboard the user is viewing, live and in place ' +
      '(unsaved). Pass "queries" (full replacement array, keeping refIds), or "refId" + "expr" to rewrite one ' +
      'query expression, and/or "datasourceUid" to point the panel at a different datasource. ' +
      'IMPORTANT: switching query language (e.g. PromQL to LogQL) REQUIRES "datasourceUid" — a new expression ' +
      'alone still runs against the old datasource. Current queries and datasource are in the page context. ' +
      'The result reports whether the change actually applied AND the panel\'s real query outcome; ' +
      'if it says a field did NOT apply, or reports an ERROR or UNVERIFIED, do not claim success — ' +
      'fix and retry, or fall back to open_explore / open_panel_editor.',
    inputSchema: {
      type: 'object',
      properties: {
        panelId: { type: 'number', description: 'Numeric id of the panel' },
        queries: {
          type: 'array',
          items: { type: ['string', 'object'] },
          description:
            'Full replacement queries: expression strings (mapped to the right field for the target datasource type) or datasource-specific query objects with refIds',
        },
        refId: { type: 'string', description: 'refId of the single query to rewrite (with "expr")' },
        expr: { type: 'string', description: 'New expression for the query identified by refId' },
        datasourceUid: {
          type: 'string',
          description:
            'Switch the panel to another datasource (uid or name). Required when the new query targets a different datasource type.',
        },
      },
      required: ['panelId'],
    },
  },
  requiresConfirmation: true,
  describeAction(args: { input: Record<string, unknown> }) {
    const panelId = String(args.input.panelId);
    const ds = asString(args.input.datasourceUid);
    const dsPart = ds ? ` on datasource ${ds}` : '';
    const expr = asString(args.input.expr);
    if (expr) {
      return `Update panel ${panelId} query to: ${expr}${dsPart}`;
    }
    if (Array.isArray(args.input.queries)) {
      return `Replace the queries of panel ${panelId}${dsPart}`;
    }
    return ds ? `Switch panel ${panelId} to datasource ${ds}` : `Update panel ${panelId}`;
  },
  async execute(args: { input: Record<string, unknown> }) {
    const panelId = asNumber(args.input.panelId);
    if (panelId === undefined) {
      return { content: '"panelId" (number) is required', isError: true };
    }

    const root = sceneRoot();
    if (!root) {
      return {
        content: 'live scene graph is not available on this page (not a Scenes dashboard?); use open_explore or open_panel_editor instead',
        isError: true,
      };
    }

    const panel = findPanel({ root, panelId });
    if (!panel) {
      return { content: `panel ${panelId} not found on the current dashboard`, isError: true };
    }
    const runner = findQueryRunner({ panel });
    if (!runner || typeof runner.setState !== 'function' || typeof runner.runQueries !== 'function') {
      return {
        content: `panel ${panelId} has no editable query runner; use open_panel_editor instead`,
        isError: true,
      };
    }

    /* Resolve the target datasource first: it decides the shape of any query
     * expressions we build ("expr" vs "query" vs "rawSql"). */
    const newDsRef = asString(args.input.datasourceUid);
    const currentDsUid = runnerDatasourceUid(runner);
    const dsInfo = resolveDatasource({ uidOrName: newDsRef ?? currentDsUid ?? '' });
    if (newDsRef && !dsInfo) {
      return { content: `unknown datasource "${newDsRef}" — pick one from the datasources list in the page context`, isError: true };
    }

    const current = Array.isArray(runner.state.queries)
      ? (runner.state.queries as Array<Record<string, unknown>>)
      : [];
    let next: Array<Record<string, unknown>>;

    const replacement = args.input.queries;
    const refId = asString(args.input.refId);
    const expr = asString(args.input.expr);

    if (Array.isArray(replacement) && replacement.length > 0) {
      next = [];
      for (let i = 0; i < replacement.length; i++) {
        const item: unknown = replacement[i];
        const fallbackRefId = String.fromCharCode(65 + i);
        if (typeof item === 'string' && item.length > 0) {
          const base = queryObjectFromString({ expression: item, datasourceType: dsInfo?.type });
          next.push({ ...base, refId: fallbackRefId });
        } else if (typeof item === 'object' && item !== null) {
          const obj = normalizeQueryObject({
            query: item as Record<string, unknown>,
            datasourceType: dsInfo?.type,
          });
          next.push({ ...obj, refId: asString(obj.refId) ?? fallbackRefId });
        }
      }
      if (next.length === 0) {
        return { content: '"queries" contained no usable entries', isError: true };
      }
    } else if (refId && expr) {
      let matched = false;
      let matchedHadExpr = true;
      next = current.map((q) => {
        if (q.refId === refId) {
          matched = true;
          matchedHadExpr = typeof q.expr === 'string';
          return { ...q, expr };
        }
        return q;
      });
      if (!matched) {
        return {
          content: `no query with refId "${refId}" on panel ${panelId} (has: ${current.map((q) => String(q.refId)).join(', ')})`,
          isError: true,
        };
      }
      /* Patching `expr` onto a query that never had one (TestData, SQL, etc.)
       * silently does nothing — the datasource ignores unknown fields. Refuse
       * so the model reports honestly instead of claiming success. A datasource
       * switch is the legitimate way to do this, since the new datasource may
       * well be expression-based. */
      if (!matchedHadExpr && !newDsRef) {
        const target = current.find((q) => q.refId === refId);
        return {
          content:
            `query "${refId}" on panel ${panelId} has no "expr" field, so this datasource does not take expressions ` +
            `(query fields: ${Object.keys(target ?? {}).join(', ')}). ` +
            'This panel cannot be rewritten with an expression — if the datasource is grafana-testdata, the data is synthetic ' +
            'and aggregation is not supported; tell the user instead of pretending. Otherwise pass "datasourceUid" to switch ' +
            'datasource, or pass full "queries" objects.',
          isError: true,
        };
      }
    } else if (newDsRef) {
      /* Datasource-only switch: keep the existing queries as-is. */
      next = current;
    } else {
      return { content: 'pass "queries", "refId"+"expr", or "datasourceUid"', isError: true };
    }

    /* A datasource switch must be written to the RUNNER, not just onto each
     * query: per-query `datasource` refs are ignored unless the panel is on
     * "-- Mixed --". Setting both keeps the two in sync either way. */
    const targetDsUid = newDsRef ? dsInfo?.uid : undefined;
    if (targetDsUid) {
      next = next.map((q) => ({ ...q, datasource: { uid: targetDsUid, type: dsInfo?.type } }));
    }

    const previousData = runner.state.data;
    runner.setState(targetDsUid ? { datasource: { uid: targetDsUid, type: dsInfo?.type }, queries: next } : { queries: next });
    runner.runQueries?.();

    /* Read the state back: whatever Scenes dropped never reached the screen. */
    const unapplied = describeUnappliedState({
      runner,
      expectedQueries: next,
      expectedDatasourceUid: targetDsUid,
    });

    const changes = [
      targetDsUid ? `datasource → ${dsInfo?.name} (${dsInfo?.type})` : undefined,
      `queries → ${JSON.stringify(next).slice(0, 400)}`,
    ]
      .filter((c): c is string => c !== undefined)
      .join('; ');

    if (unapplied.length > 0) {
      return {
        content:
          `Panel ${panelId} edit did NOT fully apply — the user's screen does not reflect this change. ` +
          `${unapplied.join('; ')}. Attempted: ${changes}. ` +
          'Tell the user it failed, or use open_panel_editor / open_explore instead.',
        isError: true,
      };
    }

    /* Feedback loop: report what the panel ACTUALLY shows after the re-run.
     * A datasource error here means the edit was wrong — the model must fix
     * and retry rather than claim success. */
    const verdict = await awaitRunnerVerdict({ runner, previousData });
    return {
      content: `Panel ${panelId} updated in place (unsaved) and re-run: ${changes}. ${verdict.summary}`,
      isError: !verdict.ok,
    };
  },
};
