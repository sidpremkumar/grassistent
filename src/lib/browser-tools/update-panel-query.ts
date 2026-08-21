import { BrowserTool, asNumber, asString } from './types';
import { awaitRunnerVerdict, findPanel, findQueryRunner, sceneRoot } from '../scene-graph';

/**
 * Tier-2 (best-effort) tool: edits a panel's queries *in place* on the live
 * Scenes dashboard — no save, no reload; the panel re-runs immediately.
 *
 * After the re-run we wait for the panel's actual PanelData to settle and
 * return the real verdict (datasource error message, or series/row counts) so
 * the model can see a wrong change and retry, instead of assuming success.
 */

export const updatePanelQueryTool: BrowserTool = {
  spec: {
    name: 'update_panel_query',
    description:
      'Edit the queries of a panel on the dashboard the user is viewing, live and in place (unsaved). ' +
      'Either pass "queries" (full replacement array of datasource query objects, keeping refIds) or ' +
      '"refId" + "expr" to rewrite one query expression. Current queries are in the page context. ' +
      'The result includes the panel\'s real query outcome (error message, or series/row counts) — ' +
      'if it reports an ERROR or unexpected empty data, fix the query and retry. ' +
      'If this fails, fall back to open_explore or open_panel_editor.',
    inputSchema: {
      type: 'object',
      properties: {
        panelId: { type: 'number', description: 'Numeric id of the panel' },
        queries: {
          type: 'array',
          items: { type: 'object' },
          description: 'Full replacement query array (objects with refId + datasource-specific fields)',
        },
        refId: { type: 'string', description: 'refId of the single query to rewrite (with "expr")' },
        expr: { type: 'string', description: 'New expression for the query identified by refId' },
      },
      required: ['panelId'],
    },
  },
  requiresConfirmation: true,
  describeAction(args: { input: Record<string, unknown> }) {
    const expr = asString(args.input.expr);
    return expr
      ? `Update panel ${String(args.input.panelId)} query to: ${expr}`
      : `Replace the queries of panel ${String(args.input.panelId)}`;
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

    const current = runner.state.queries as Array<Record<string, unknown>>;
    let next: Array<Record<string, unknown>>;

    const replacement = args.input.queries;
    const refId = asString(args.input.refId);
    const expr = asString(args.input.expr);

    if (Array.isArray(replacement) && replacement.length > 0) {
      next = replacement.filter(
        (q): q is Record<string, unknown> => typeof q === 'object' && q !== null,
      );
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
       * so the model reports honestly instead of claiming success. */
      if (!matchedHadExpr) {
        const target = current.find((q) => q.refId === refId);
        return {
          content:
            `query "${refId}" on panel ${panelId} has no "expr" field, so this datasource does not take expressions ` +
            `(query fields: ${Object.keys(target ?? {}).join(', ')}). ` +
            'This panel cannot be rewritten with an expression — if the datasource is grafana-testdata, the data is synthetic ' +
            'and aggregation is not supported; tell the user instead of pretending. Otherwise pass full "queries" objects.',
          isError: true,
        };
      }
    } else {
      return { content: 'pass either "queries" or "refId"+"expr"', isError: true };
    }

    const previousData = runner.state.data;
    runner.setState({ queries: next });
    runner.runQueries?.();

    /* Feedback loop: report what the panel ACTUALLY shows after the re-run.
     * A datasource error here means the edit was wrong — the model must fix
     * and retry rather than claim success. */
    const verdict = await awaitRunnerVerdict({ runner, previousData });
    return {
      content:
        `Panel ${panelId} queries updated in place (unsaved) and re-run: ${JSON.stringify(next).slice(0, 500)}. ` +
        verdict.summary,
      isError: !verdict.ok,
    };
  },
};
