import { BrowserTool, asNumber, asString } from './types';

/**
 * Tier-2 (best-effort) tool: edits a panel's queries *in place* on the live
 * Scenes dashboard — no save, no reload; the panel re-runs immediately.
 *
 * Grafana 13 exposes the active scene root at `window.__grafanaSceneContext`.
 * That is a semi-private surface, so everything here is structural typing +
 * guards: if the scene graph is missing or its shape drifts, we return a clean
 * error and the model falls back to open_explore / open_panel_editor guidance.
 */

/** Structural view of a scene object: state bag + optional mutators. */
type SceneObjectLike = {
  state: Record<string, unknown>;
  setState?: (partial: Record<string, unknown>) => void;
  runQueries?: () => void;
};

function isSceneObject(value: unknown): value is SceneObjectLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { state?: unknown }).state === 'object' &&
    (value as { state?: unknown }).state !== null
  );
}

/** Depth-first walk over the scene graph collecting nodes matching `match`. */
function findSceneObjects(args: {
  root: SceneObjectLike;
  match: (node: SceneObjectLike) => boolean;
}): SceneObjectLike[] {
  const found: SceneObjectLike[] = [];
  const visited = new Set<SceneObjectLike>();
  const stack: SceneObjectLike[] = [args.root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || visited.has(node)) {
      continue;
    }
    visited.add(node);
    if (args.match(node)) {
      found.push(node);
    }
    for (const value of Object.values(node.state)) {
      if (isSceneObject(value)) {
        stack.push(value);
      } else if (Array.isArray(value)) {
        for (const item of value) {
          if (isSceneObject(item)) {
            stack.push(item);
          }
        }
      }
    }
  }
  return found;
}

/** A VizPanel node is identified by key "panel-<id>" plus a pluginId. */
function findPanel(args: { root: SceneObjectLike; panelId: number }): SceneObjectLike | undefined {
  const keyPattern = new RegExp(`^panel-${args.panelId}(?:$|-)`);
  return findSceneObjects({
    root: args.root,
    match: (node) =>
      typeof node.state.key === 'string' &&
      keyPattern.test(node.state.key) &&
      typeof node.state.pluginId === 'string',
  })[0];
}

/**
 * Follows the panel's $data chain (transformers wrap the runner) to the
 * SceneQueryRunner: the node owning a `queries` array and `runQueries()`.
 */
function findQueryRunner(args: { panel: SceneObjectLike }): SceneObjectLike | undefined {
  let node: unknown = args.panel.state.$data;
  for (let depth = 0; depth < 5 && isSceneObject(node); depth++) {
    if (Array.isArray(node.state.queries) && typeof node.runQueries === 'function') {
      return node;
    }
    node = node.state.$data;
  }
  return undefined;
}

export const updatePanelQueryTool: BrowserTool = {
  spec: {
    name: 'update_panel_query',
    description:
      'Edit the queries of a panel on the dashboard the user is viewing, live and in place (unsaved). ' +
      'Either pass "queries" (full replacement array of datasource query objects, keeping refIds) or ' +
      '"refId" + "expr" to rewrite one query expression. Current queries are in the page context. ' +
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

    const root: unknown = (window as unknown as { __grafanaSceneContext?: unknown }).__grafanaSceneContext;
    if (!isSceneObject(root)) {
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

    runner.setState({ queries: next });
    runner.runQueries?.();
    return {
      content: `Panel ${panelId} queries updated in place (unsaved) and re-run: ${JSON.stringify(next).slice(0, 500)}`,
    };
  },
};
