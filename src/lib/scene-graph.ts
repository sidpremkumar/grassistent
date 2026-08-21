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

/**
 * A VizPanel node is identified by key "panel-<id>" plus a pluginId.
 *
 * Grafana also creates *derived* keys ("panel-3-clone-1", the edit-mode copy,
 * repeats, library panels), so an exact key match is preferred: mutating a
 * clone instead of the node on screen looks like a successful no-op. Suffixed
 * keys are only used as a fallback when no exact match exists.
 */
export function findPanel(args: { root: SceneObjectLike; panelId: number }): SceneObjectLike | undefined {
  const exactKey = `panel-${args.panelId}`;
  const keyPattern = new RegExp(`^panel-${args.panelId}(?:$|-)`);
  const candidates = findSceneObjects({
    root: args.root,
    match: (node) =>
      typeof node.state.key === 'string' &&
      keyPattern.test(node.state.key) &&
      typeof node.state.pluginId === 'string',
  });
  return candidates.find((node) => node.state.key === exactKey) ?? candidates[0];
}

/** The uid of a runner's datasource, whether stored as a ref object or string. */
export function runnerDatasourceUid(runner: SceneObjectLike): string | undefined {
  const ds = runner.state.datasource;
  if (typeof ds === 'string') {
    return ds;
  }
  if (typeof ds === 'object' && ds !== null) {
    const uid = (ds as { uid?: unknown }).uid;
    return typeof uid === 'string' ? uid : undefined;
  }
  return undefined;
}

/** Deep structural equality over JSON-ish tool input values. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (typeof a !== typeof b || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => deepEqual(item, b[i]))
    );
  }
  if (typeof a !== 'object') {
    return false;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = Object.keys(ao);
  return keys.length === Object.keys(bo).length && keys.every((k) => deepEqual(ao[k], bo[k]));
}

/**
 * Reads back a runner's state after a mutation and reports what did NOT stick.
 *
 * `setState` is a silent write: Scenes ignores fields the node does not own
 * (the classic case is a panel datasource, which lives on the runner, not on
 * the individual queries). Without this read-back a no-op edit produces a
 * healthy query verdict and the model confidently reports success while the
 * user's screen never changed. Every mismatch here is a real failure.
 */
export function describeUnappliedState(args: {
  runner: SceneObjectLike;
  expectedQueries: Array<Record<string, unknown>>;
  expectedDatasourceUid?: string;
}): string[] {
  const problems: string[] = [];

  if (args.expectedDatasourceUid) {
    const actual = runnerDatasourceUid(args.runner);
    if (actual !== args.expectedDatasourceUid) {
      problems.push(
        `datasource did NOT change: panel is still on uid=${actual ?? 'unset'} ` +
          `(wanted uid=${args.expectedDatasourceUid})`,
      );
    }
  }

  const actualQueries = Array.isArray(args.runner.state.queries)
    ? (args.runner.state.queries as Array<Record<string, unknown>>)
    : [];
  if (actualQueries.length !== args.expectedQueries.length) {
    problems.push(
      `query count did NOT change as requested: panel has ${actualQueries.length}, wanted ${args.expectedQueries.length}`,
    );
    return problems;
  }
  for (let i = 0; i < args.expectedQueries.length; i++) {
    const expected = args.expectedQueries[i];
    const refId = typeof expected.refId === 'string' ? expected.refId : undefined;
    const actual = refId
      ? actualQueries.find((q) => q.refId === refId) ?? actualQueries[i]
      : actualQueries[i];
    if (!actual) {
      problems.push(`query ${refId ?? `#${i}`} is missing from the panel after the edit`);
      continue;
    }
    const dropped = Object.keys(expected).filter((key) => !deepEqual(actual[key], expected[key]));
    if (dropped.length > 0) {
      problems.push(
        `query ${refId ?? `#${i}`} did NOT accept these fields: ${dropped
          .map((k) => `${k}=${JSON.stringify(expected[k])} (still ${JSON.stringify(actual[k])})`)
          .join(', ')}`,
      );
    }
  }
  return problems;
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
 *
 * A timeout is reported as a FAILURE, not a success: "still Loading after 8s"
 * means we cannot claim the user's panel now shows the requested data, and the
 * model must say so rather than assert the edit worked.
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
        ok: false,
        summary:
          `panel result: UNVERIFIED — still ${data?.state ?? 'unknown'} after ${Math.round(timeoutMs / 1000)}s` +
          `${isStale ? ' (result never refreshed, the edit may not have triggered a re-query)' : ''}. ` +
          'Do NOT tell the user the panel is updated; report that the result could not be confirmed.',
      };
    }
    await new Promise((resolve) => window.setTimeout(resolve, 250));
  }
}

/**
 * Reads the queries + datasource actually loaded in the live scene, keyed by
 * numeric panel id.
 *
 * Page context otherwise reads the *saved* dashboard model from the API, which
 * cannot see in-place (unsaved) edits — so after `update_panel_query` the model
 * would be shown the ORIGINAL query and could never tell that its own edit was
 * a no-op. This is the ground truth the user is looking at.
 */
export function collectLivePanelQueries(): Map<
  number,
  { datasourceUid?: string; queries: Array<Record<string, unknown>> }
> {
  const live = new Map<number, { datasourceUid?: string; queries: Array<Record<string, unknown>> }>();
  const root = sceneRoot();
  if (!root) {
    return live;
  }
  const panels = findSceneObjects({
    root,
    match: (node) =>
      typeof node.state.key === 'string' &&
      /^panel-\d+/.test(node.state.key) &&
      typeof node.state.pluginId === 'string',
  });
  for (const panel of panels) {
    const key = typeof panel.state.key === 'string' ? panel.state.key : '';
    const id = Number(key.match(/^panel-(\d+)/)?.[1]);
    if (!Number.isFinite(id) || live.has(id)) {
      continue;
    }
    const runner = findQueryRunner({ panel });
    if (!runner || !Array.isArray(runner.state.queries)) {
      continue;
    }
    live.set(id, {
      datasourceUid: runnerDatasourceUid(runner),
      queries: runner.state.queries as Array<Record<string, unknown>>,
    });
  }
  return live;
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
