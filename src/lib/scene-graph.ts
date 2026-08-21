/**
 * Structural helpers over Grafana's live Scenes graph
 * (`window.__grafanaSceneContext`). This is a semi-private surface, so
 * everything is duck-typed with guards: when the shape drifts we return
 * undefined and callers degrade gracefully.
 *
 * The key capability here is *observing query results*: after a tool mutates a
 * panel (or a variable/time change re-queries it), the SceneQueryRunner's
 * `state.data` carries the real PanelData — loading state, error messages,
 * series — which is the ground truth the human sees on screen. Feeding that
 * back to the model is what lets it notice a wrong change and retry.
 */

/** Structural view of a scene object: state bag + optional mutators. */
export type SceneObjectLike = {
  state: Record<string, unknown>;
  setState?: (partial: Record<string, unknown>) => void;
  runQueries?: () => void;
};

export function isSceneObject(value: unknown): value is SceneObjectLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { state?: unknown }).state === 'object' &&
    (value as { state?: unknown }).state !== null
  );
}

/** The active scene root, when Grafana exposes one on this page. */
export function sceneRoot(): SceneObjectLike | undefined {
  const root: unknown = (window as unknown as { __grafanaSceneContext?: unknown }).__grafanaSceneContext;
  return isSceneObject(root) ? root : undefined;
}

/** Depth-first walk over the scene graph collecting nodes matching `match`. */
export function findSceneObjects(args: {
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
export function findPanel(args: { root: SceneObjectLike; panelId: number }): SceneObjectLike | undefined {
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
export function findQueryRunner(args: { panel: SceneObjectLike }): SceneObjectLike | undefined {
  let node: unknown = args.panel.state.$data;
  for (let depth = 0; depth < 5 && isSceneObject(node); depth++) {
    if (Array.isArray(node.state.queries) && typeof node.runQueries === 'function') {
      return node;
    }
    node = node.state.$data;
  }
  return undefined;
}

/** Structural subset of @grafana/data PanelData as found on runner.state.data. */
type PanelDataLike = {
  state?: string;
  series?: Array<{ length?: number; fields?: unknown[] }>;
  errors?: Array<{ message?: string; refId?: string }>;
  error?: { message?: string; refId?: string };
};

function readPanelData(runner: SceneObjectLike): PanelDataLike | undefined {
  const data = runner.state.data;
  return typeof data === 'object' && data !== null ? (data as PanelDataLike) : undefined;
}

function describeErrors(data: PanelDataLike): string[] {
  const all = [...(data.errors ?? []), ...(data.error ? [data.error] : [])];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of all) {
    const msg = `${e.refId ? `${e.refId}: ` : ''}${e.message ?? 'unknown error'}`;
    if (!seen.has(msg)) {
      seen.add(msg);
      out.push(msg);
    }
  }
  return out;
}

/** One-line human/model-readable verdict of a runner's current PanelData. */
function summarizeData(data: PanelDataLike): { ok: boolean; summary: string } {
  if (data.state === 'Error') {
    const errors = describeErrors(data);
    return {
      ok: false,
      summary: `ERROR — ${errors.length > 0 ? errors.join('; ') : 'query failed with no message'}`,
    };
  }
  const series = data.series ?? [];
  const rows = series.reduce((acc, s) => acc + (typeof s.length === 'number' ? s.length : 0), 0);
  if (series.length === 0) {
    return { ok: true, summary: 'ran without error but returned NO data (0 series) — check the query matches anything' };
  }
  return { ok: true, summary: `${series.length} series, ~${rows} rows` };
}

/**
 * Waits for a query runner to settle after `runQueries()` and reports what the
 * panel actually shows: the datasource's error message on failure, series/row
 * counts on success. This is more faithful than replaying the query through
 * /api/ds/query because the runner interpolates template variables and panel
 * options exactly like the panel on screen does.
 *
 * Pass `previousData` (the runner's data object captured BEFORE the mutation)
 * so a stale settled result is not mistaken for the new one.
 */
export async function awaitRunnerVerdict(args: {
  runner: SceneObjectLike;
  previousData?: unknown;
  timeoutMs?: number;
}): Promise<{ ok: boolean; summary: string }> {
  const timeoutMs = args.timeoutMs ?? 8000;
  const started = Date.now();
  /* Give the runner a beat to flip into Loading before we start sampling. */
  await new Promise((resolve) => window.setTimeout(resolve, 150));
  for (;;) {
    const data = readPanelData(args.runner);
    const isStale = args.previousData !== undefined && args.runner.state.data === args.previousData;
    if (data && !isStale && (data.state === 'Done' || data.state === 'Error')) {
      const verdict = summarizeData(data);
      return { ok: verdict.ok, summary: `panel result: ${verdict.summary}` };
    }
    if (Date.now() - started > timeoutMs) {
      return {
        ok: true,
        summary: `panel result: still ${data?.state ?? 'unknown'} after ${Math.round(timeoutMs / 1000)}s — check the refreshed page context for errors`,
      };
    }
    await new Promise((resolve) => window.setTimeout(resolve, 250));
  }
}

/**
 * Scans every query runner on the current scene for error/empty states.
 * Used by page-context extraction so the model sees panel-level failures
 * (which never surface as toasts) after ANY action — variable changes, time
 * range moves, its own edits.
 */
export function collectPanelErrors(): string[] {
  const root = sceneRoot();
  if (!root) {
    return [];
  }
  const panels = findSceneObjects({
    root,
    match: (node) =>
      typeof node.state.key === 'string' &&
      /^panel-\d+/.test(node.state.key) &&
      typeof node.state.pluginId === 'string',
  });
  const out: string[] = [];
  for (const panel of panels) {
    const runner = findQueryRunner({ panel });
    const data = runner ? readPanelData(runner) : undefined;
    if (!data || data.state !== 'Error') {
      continue;
    }
    const errors = describeErrors(data);
    const title = typeof panel.state.title === 'string' && panel.state.title ? ` "${panel.state.title}"` : '';
    const key = typeof panel.state.key === 'string' ? panel.state.key : '?';
    out.push(`[${key}${title}] query ERROR: ${errors.join('; ') || 'no message'}`);
  }
  return out;
}
