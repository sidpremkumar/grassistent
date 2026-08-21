import { BrowserToolSpec } from '../protocol';
import { BrowserTool, BrowserToolContext, BrowserToolOutcome } from './types';
import { setTimeRangeTool } from './set-time-range';
import { setVariableTool } from './set-variable';
import { navigateTool } from './navigate';
import { openExploreTool } from './open-explore';
import { openPanelEditorTool } from './open-panel-editor';
import { refreshTool } from './refresh';
import { askUserTool } from './ask-user';
import { updatePanelQueryTool } from './update-panel-query';
import { updateExploreQueryTool } from './update-explore-query';

/**
 * The registry of tools this frontend executes in the user's page. Advertised
 * to the backend with every chat request (namespaced `browser__*` there), and
 * dispatched here when the agent loop pauses on a browser tool call.
 */
const registry: BrowserTool[] = [
  setTimeRangeTool,
  setVariableTool,
  navigateTool,
  openExploreTool,
  openPanelEditorTool,
  refreshTool,
  askUserTool,
  updatePanelQueryTool,
  updateExploreQueryTool,
];

/** Tool manifest sent with every ChatRequest. */
export function browserToolSpecs(): BrowserToolSpec[] {
  return registry.map((t) => t.spec);
}

/**
 * Executes one browser tool call, applying the confirmation gate for mutating
 * tools. Unknown tools and thrown errors become error outcomes so the model
 * can adapt instead of the turn dying.
 */
export async function executeBrowserTool(args: {
  name: string;
  input: Record<string, unknown>;
  ctx: BrowserToolContext;
}): Promise<BrowserToolOutcome> {
  const tool = registry.find((t) => t.spec.name === args.name);
  if (!tool) {
    return { content: `unknown browser tool "${args.name}"`, isError: true };
  }
  try {
    const needsConfirmation = tool.needsConfirmation
      ? tool.needsConfirmation({ input: args.input })
      : Boolean(tool.requiresConfirmation);
    if (needsConfirmation) {
      const description = tool.describeAction?.({ input: args.input }) ?? `Run ${args.name}`;
      const approved = await args.ctx.confirm({ description });
      if (!approved) {
        return { content: 'The user declined this action.', isError: true };
      }
    }
    return await tool.execute({ input: args.input, ctx: args.ctx });
  } catch (err) {
    return { content: `browser tool "${args.name}" failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}
