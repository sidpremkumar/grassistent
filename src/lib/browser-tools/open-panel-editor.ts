import { locationService } from '@grafana/runtime';
import { BrowserTool, asNumber } from './types';

/**
 * Opens a panel's editor (`?editPanel=<id>`) so the user lands directly in the
 * query editor for the panel being discussed. Panel ids come from the
 * dashboard model in the page context.
 */
export const openPanelEditorTool: BrowserTool = {
  spec: {
    name: 'open_panel_editor',
    description:
      'Open the edit view of a panel on the current dashboard so the user can see and change its queries. ' +
      'Requires the numeric panel id from the dashboard.',
    inputSchema: {
      type: 'object',
      properties: {
        panelId: { type: 'number', description: 'Numeric id of the panel to edit' },
      },
      required: ['panelId'],
    },
  },
  async execute(args: { input: Record<string, unknown> }) {
    const panelId = asNumber(args.input.panelId);
    if (panelId === undefined) {
      return { content: '"panelId" (number) is required', isError: true };
    }
    locationService.partial({ editPanel: String(panelId), viewPanel: null });
    return { content: `Opened the editor for panel ${panelId}.` };
  },
};
