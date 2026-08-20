import { locationService } from '@grafana/runtime';
import { BrowserTool, asString } from './types';

/**
 * Sets a dashboard template variable via its `var-<name>` URL param. Scenes
 * dashboards re-query affected panels immediately.
 */
export const setVariableTool: BrowserTool = {
  spec: {
    name: 'set_variable',
    description:
      'Set a dashboard template variable to a value. The dashboard re-queries immediately. ' +
      'Variable names are listed in the page context.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Variable name without the "var-" prefix' },
        value: { type: 'string', description: 'New value for the variable' },
      },
      required: ['name', 'value'],
    },
  },
  async execute(args: { input: Record<string, unknown> }) {
    const name = asString(args.input.name);
    const value = asString(args.input.value);
    if (!name || !value) {
      return { content: 'both "name" and "value" are required', isError: true };
    }
    locationService.partial({ [`var-${name}`]: value });
    return { content: `Variable ${name} set to "${value}".` };
  },
};
