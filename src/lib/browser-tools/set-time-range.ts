import { locationService } from '@grafana/runtime';
import { BrowserTool, asString } from './types';

/**
 * Sets the dashboard/Explore time range via URL state — the officially
 * supported live-update path; Scenes reacts immediately without a reload.
 */
export const setTimeRangeTool: BrowserTool = {
  spec: {
    name: 'set_time_range',
    description:
      'Set the time range of the page the user is viewing (dashboard or Explore). ' +
      'Accepts Grafana time syntax: relative ("now-6h", "now") or absolute ISO/epoch-ms values.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Range start, e.g. "now-1h" or "2026-08-20T10:00:00Z"' },
        to: { type: 'string', description: 'Range end, e.g. "now"' },
      },
      required: ['from', 'to'],
    },
  },
  async execute(args: { input: Record<string, unknown> }) {
    const from = asString(args.input.from);
    const to = asString(args.input.to);
    if (!from || !to) {
      return { content: 'both "from" and "to" are required', isError: true };
    }
    locationService.partial({ from, to });
    return { content: `Time range set to ${from} → ${to}.` };
  },
};
