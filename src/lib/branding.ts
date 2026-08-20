import { getBackendSrv } from '@grafana/runtime';

/**
 * Operator-configurable branding for the chat UI, stored in the plugin's
 * (non-secret) jsonData and read client-side. Lets a deployment swap the
 * default icon/labels for their own — e.g. a company logo — without forking.
 *
 * `icon` accepts either a base64 data URI (e.g. "data:image/svg+xml;base64,...")
 * or an absolute/relative image URL. When unset, the UI falls back to the
 * built-in Grafana glyph.
 */
export type Branding = {
  /** Data URI or URL for a custom icon shown in the header, top-bar button, and FAB. */
  icon?: string;
  /** Product name shown in the panel header (default "MCP Agent"). */
  name?: string;
  /** Subtitle under the name (default "Context-aware assistant"). */
  subtitle?: string;
};

const PLUGIN_ID = 'mcpagent-app';

type SettingsResponse = {
  jsonData?: {
    brandIcon?: string;
    brandName?: string;
    brandSubtitle?: string;
  };
};

/**
 * Cached at module scope so the settings endpoint is hit at most once per page
 * load regardless of how many components ask for branding.
 */
let cached: Promise<Branding> | undefined;

/**
 * Fetches operator branding from the plugin settings. Never rejects — on any
 * error it resolves to empty branding so the UI cleanly falls back to defaults.
 */
export function loadBranding(): Promise<Branding> {
  if (!cached) {
    cached = getBackendSrv()
      .get<SettingsResponse>(`/api/plugins/${PLUGIN_ID}/settings`)
      .then((res) => ({
        icon: res?.jsonData?.brandIcon || undefined,
        name: res?.jsonData?.brandName || undefined,
        subtitle: res?.jsonData?.brandSubtitle || undefined,
      }))
      .catch(() => ({}));
  }
  return cached;
}

/**
 * Basic guard so we only ever render icon values that are safe as an <img> src:
 * an http(s) URL, a same-origin relative path, or a data:image/* URI. Anything
 * else (e.g. a "javascript:" URL) is rejected and the caller falls back.
 */
export function isSafeIconSrc(src: string | undefined): src is string {
  if (!src) {
    return false;
  }
  const value = src.trim();
  if (value.startsWith('data:image/')) {
    return true;
  }
  if (value.startsWith('https://') || value.startsWith('http://') || value.startsWith('/')) {
    return true;
  }
  return false;
}
