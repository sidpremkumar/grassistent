import { getDataSourceSrv } from '@grafana/runtime';

/**
 * Datasource-aware helpers shared by page context extraction and the Explore
 * browser tools. Query shapes are datasource-type-specific ("expr" for
 * Prometheus/Loki, "query"+"queryType" for Tempo, "rawSql" for SQL, ...), so
 * anything that composes or describes queries needs to know the type behind a
 * uid — not just the uid string.
 */

export type DatasourceInfo = {
  uid: string;
  name: string;
  type: string;
  isDefault: boolean;
};

/** Resolve a datasource uid (or name) to its instance settings, best-effort. */
export function resolveDatasource(args: { uidOrName: string }): DatasourceInfo | undefined {
  try {
    const settings = getDataSourceSrv().getInstanceSettings(args.uidOrName);
    if (!settings) {
      return undefined;
    }
    return {
      uid: settings.uid,
      name: settings.name,
      type: settings.type,
      isDefault: Boolean(settings.isDefault),
    };
  } catch {
    return undefined;
  }
}

/** "name (type, uid=...)" — enough for the model to pick and reason about it. */
export function describeDatasourceInfo(args: { info: DatasourceInfo }): string {
  return `${args.info.name} (type=${args.info.type}, uid=${args.info.uid})${args.info.isDefault ? ' [default]' : ''}`;
}

/** Render a uid with its resolved type when possible, else the raw uid. */
export function describeDatasourceUid(args: { uidOrName: string }): string {
  const info = resolveDatasource({ uidOrName: args.uidOrName });
  return info ? describeDatasourceInfo({ info }) : args.uidOrName;
}

/** All datasources visible to the user, capped so context stays bounded. */
export function listDatasources(args: { limit?: number }): string[] {
  const limit = args.limit ?? 30;
  try {
    return getDataSourceSrv()
      .getList()
      .slice(0, limit)
      .map((ds) =>
        describeDatasourceInfo({
          info: { uid: ds.uid, name: ds.name, type: ds.type, isDefault: Boolean(ds.isDefault) },
        }),
      );
  } catch {
    return [];
  }
}

const SQL_TYPES = new Set([
  'mysql',
  'postgres',
  'grafana-postgresql-datasource',
  'mssql',
  'grafana-mysql-datasource',
]);

/**
 * Turn a bare expression string into the correct query object for the target
 * datasource type. This is where "just a string" stops meaning "expr":
 * Tempo takes TraceQL in "query" (+ queryType so Explore opens the right tab),
 * SQL datasources take "rawSql", Elasticsearch takes "query".
 */
export function queryObjectFromString(args: {
  expression: string;
  datasourceType: string | undefined;
}): Record<string, unknown> {
  const type = args.datasourceType ?? '';
  if (type === 'tempo') {
    return { query: args.expression, queryType: 'traceql' };
  }
  if (SQL_TYPES.has(type)) {
    return { rawSql: args.expression, format: 'table' };
  }
  if (type === 'elasticsearch') {
    return { query: args.expression };
  }
  /* Prometheus, Loki, and the long tail of expr-style datasources. */
  return { expr: args.expression };
}

/**
 * Fill in datasource-specific defaults on a full query object so Explore
 * renders the right editor tab. For Tempo, `queryType` decides the
 * Search/TraceQL/Service Graph tab, so leaving it unset strands the user on
 * whatever tab was last open.
 */
export function normalizeQueryObject(args: {
  query: Record<string, unknown>;
  datasourceType: string | undefined;
}): Record<string, unknown> {
  if (args.datasourceType !== 'tempo' || typeof args.query.queryType === 'string') {
    return args.query;
  }
  if (Array.isArray(args.query.filters)) {
    return { ...args.query, queryType: 'traceqlSearch' };
  }
  if (typeof args.query.query === 'string') {
    return { ...args.query, queryType: 'traceql' };
  }
  return args.query;
}
