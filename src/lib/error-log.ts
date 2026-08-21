import { BusEventWithPayload } from '@grafana/data';
import { getAppEvents } from '@grafana/runtime';

/**
 * Captures error/warning toasts published on Grafana's app event bus into a
 * small ring buffer, so page-context extraction can show the agent what just
 * failed on screen (e.g. a datasource save error) instead of leaving it blind
 * to everything outside the URL.
 */

type CapturedAlert = {
  severity: 'error' | 'warning';
  text: string;
  at: number;
};

const MAX_ENTRIES = 20;
/** Alerts older than this are stale for "what just happened" purposes. */
const FRESHNESS_MS = 5 * 60 * 1000;

const buffer: CapturedAlert[] = [];
let initialized = false;

/** Legacy alert events are published as plain {type, payload} objects. */
class AlertErrorEvent extends BusEventWithPayload<unknown[]> {
  static type = 'alert-error';
}
class AlertWarningEvent extends BusEventWithPayload<unknown[]> {
  static type = 'alert-warning';
}

function record(args: { severity: CapturedAlert['severity']; payload: unknown }): void {
  const parts = Array.isArray(args.payload) ? args.payload : [args.payload];
  const text = parts
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
    .join(' — ');
  if (!text) {
    return;
  }
  buffer.push({ severity: args.severity, text, at: Date.now() });
  if (buffer.length > MAX_ENTRIES) {
    buffer.splice(0, buffer.length - MAX_ENTRIES);
  }
}

/** Subscribe once to the app event bus. Safe to call repeatedly. */
export function initErrorCapture(): void {
  if (initialized) {
    return;
  }
  initialized = true;
  try {
    const bus = getAppEvents();
    bus.subscribe(AlertErrorEvent, (e) => record({ severity: 'error', payload: e.payload }));
    bus.subscribe(AlertWarningEvent, (e) => record({ severity: 'warning', payload: e.payload }));
  } catch {
    /* Event bus unavailable (tests, very old Grafana) — degrade silently. */
  }
}

/** Recent alerts, newest last, formatted for the page context. */
export function recentAlerts(): string[] {
  const cutoff = Date.now() - FRESHNESS_MS;
  return buffer
    .filter((a) => a.at >= cutoff)
    .map((a) => {
      const secondsAgo = Math.round((Date.now() - a.at) / 1000);
      return `[${a.severity}, ${secondsAgo}s ago] ${a.text}`;
    });
}
