import { rangeUtil } from '@grafana/data';
import { getBackendSrv } from '@grafana/runtime';

/**
 * Runs composed queries server-side through /api/ds/query so the agent gets a
 * real verdict (frame counts or the datasource's error message) instead of
 * assuming its URL push worked. Explore renders errors only to the human;
 * this is how the model gets to see them too.
 */

type DsQueryResult = {
  results?: Record<
    string,
    {
      frames?: Array<{ data?: { values?: unknown[][] } }>;
      error?: string;
      status?: number;
    }
  >;
};

type FetchErrorLike = {
  status?: number;
  statusText?: string;
  data?: { message?: string; error?: string; results?: DsQueryResult['results'] };
};

function isFetchErrorLike(value: unknown): value is FetchErrorLike {
  return typeof value === 'object' && value !== null;
}

/** Convert Grafana raw time syntax ("now-1h") to epoch-ms strings. */
function toEpochRange(args: { from: string; to: string }): { from: string; to: string } {
  try {
    const range = rangeUtil.convertRawToRange({ from: args.from, to: args.to });
    return { from: String(range.from.valueOf()), to: String(range.to.valueOf()) };
  } catch {
    return { from: args.from, to: args.to };
  }
}

function summarizeResults(results: DsQueryResult['results']): string {
  if (!results) {
    return 'no results returned';
  }
  const parts: string[] = [];
  for (const [refId, r] of Object.entries(results)) {
    if (r.error) {
      parts.push(`${refId}: ERROR ${r.status ?? ''} ${r.error}`.trim());
      continue;
    }
    const frames = r.frames ?? [];
    const rows = frames.reduce((acc, f) => acc + (f.data?.values?.[0]?.length ?? 0), 0);
    parts.push(`${refId}: ${frames.length} frame${frames.length === 1 ? '' : 's'}, ~${rows} rows`);
  }
  return parts.join('; ');
}

/**
 * Executes the queries and returns a one-line verdict. Never throws — a
 * verification failure is information for the model, not a tool crash.
 */
export async function verifyQueries(args: {
  queries: Array<Record<string, unknown>>;
  from: string;
  to: string;
}): Promise<{ ok: boolean; summary: string }> {
  const range = toEpochRange({ from: args.from, to: args.to });
  const body = { queries: args.queries, from: range.from, to: range.to };
  try {
    const res = await getBackendSrv().post<DsQueryResult>('/api/ds/query', body, {
      showErrorAlert: false,
    });
    const summary = summarizeResults(res.results);
    const ok = !/\bERROR\b/.test(summary);
    return { ok, summary: `query verification: ${summary}` };
  } catch (err) {
    if (isFetchErrorLike(err)) {
      const nested = err.data?.results ? summarizeResults(err.data.results) : undefined;
      const message = nested ?? err.data?.message ?? err.data?.error ?? err.statusText ?? 'request failed';
      return { ok: false, summary: `query verification FAILED (HTTP ${err.status ?? '?'}): ${message}` };
    }
    return { ok: false, summary: `query verification FAILED: ${err instanceof Error ? err.message : String(err)}` };
  }
}
