import { locationService } from '@grafana/runtime';
import { BrowserTool, asString } from './types';

/**
 * Navigates the current tab to another Grafana page. Only same-origin relative
 * paths are allowed so the model can never send the user off-site.
 */
export const navigateTool: BrowserTool = {
  spec: {
    name: 'navigate',
    description:
      'Navigate the user to another Grafana page. Path must be a relative Grafana path such as ' +
      '"/dashboards", "/d/<uid>", "/alerting/list" or "/explore".',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative Grafana path, optionally with query params' },
      },
      required: ['path'],
    },
  },
  async execute(args: { input: Record<string, unknown> }) {
    const path = asString(args.input.path);
    if (!path) {
      return { content: '"path" is required', isError: true };
    }
    if (!path.startsWith('/') || path.startsWith('//')) {
      return { content: `refusing to navigate to non-relative path "${path}"`, isError: true };
    }
    locationService.push(path);
    return { content: `Navigated to ${path}.` };
  },
};
