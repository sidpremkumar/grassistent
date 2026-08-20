import { getAppEvents, RefreshEvent } from '@grafana/runtime';
import { BrowserTool } from './types';

/**
 * Publishes a RefreshEvent on the app event bus, re-running the queries of
 * whatever is on screen.
 */
export const refreshTool: BrowserTool = {
  spec: {
    name: 'refresh',
    description: 'Refresh the current page data (re-run the queries of the dashboard/panels on screen).',
    inputSchema: { type: 'object', properties: {} },
  },
  async execute() {
    getAppEvents().publish(new RefreshEvent());
    return { content: 'Refreshed the page data.' };
  },
};
