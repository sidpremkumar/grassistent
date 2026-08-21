import { BrowserToolSpec } from '../protocol';

/**
 * Browser tools execute in the user's page with the user's own Grafana
 * session. They are advertised to the backend per-request and invoked when the
 * agent loop pauses on a `browser__*` tool call.
 */

/** Result of executing one browser tool. */
export type BrowserToolOutcome = {
  content: string;
  isError?: boolean;
};

/**
 * Capabilities the chat UI injects into tool execution: user prompts and
 * confirmation gates render inline in the chat panel.
 */
export type BrowserToolContext = {
  /** Ask the user a question; resolves with the chosen option or typed text. */
  promptUser(args: { prompt: string; options?: string[] }): Promise<string>;
  /**
   * Ask the user to approve a mutating action; resolves false on deny. The tool
   * name and raw input are passed through so the chat panel can render the
   * exact arguments (pretty-printed JSON) alongside the human description.
   * "Always allow" grants a blanket approval for the rest of this chat only.
   */
  confirm(args: {
    description: string;
    toolName: string;
    input: Record<string, unknown>;
  }): Promise<boolean>;
};

export type BrowserTool = {
  spec: BrowserToolSpec;
  /** Mutating tools are gated behind an inline confirmation chip. */
  requiresConfirmation?: boolean;
  /**
   * Per-call gate for tools that are only sometimes mutating (e.g. switching
   * an Explore tab is free, rewriting the query needs approval). Takes
   * precedence over `requiresConfirmation` when defined.
   */
  needsConfirmation?(args: { input: Record<string, unknown> }): boolean;
  /** Short human description of what will happen, shown in the confirm chip. */
  describeAction?(args: { input: Record<string, unknown> }): string;
  execute(args: { input: Record<string, unknown>; ctx: BrowserToolContext }): Promise<BrowserToolOutcome>;
};

/** Narrow an unknown tool input field to a string, else undefined. */
export function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Narrow an unknown tool input field to a finite number, else undefined. */
export function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}
