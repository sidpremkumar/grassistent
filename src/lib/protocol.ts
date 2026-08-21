/**
 * Protocol between the plugin frontend and its Go backend.
 *
 * The frontend POSTs a chat turn to the backend resource endpoint and receives
 * a stream of Server-Sent Events. These types describe that stream. The agent
 * loop (Bedrock Converse + MCP tools) lives entirely in the Go backend; the
 * frontend only renders these events.
 */

/* ---- Frontend -> Backend (request body of POST /resources/chat) ---- */

export type PageContext = {
  /** Human-readable summary of what the user is looking at (dashboard/panel/alert). */
  summary?: string;
  dashboardTitle?: string;
  dashboardUid?: string;
  panelTitle?: string;
  /** Raw datasource queries for the focused/related panels. */
  queries?: string[];
  datasource?: string;
  timeRange?: { from: string; to: string };
  /** URL of the page the chat was launched from. */
  url?: string;
  /** Template variables as "name=value" pairs. */
  variables?: string[];
  /** Datasources available to the user: "name (type=..., uid=...)". */
  datasources?: string[];
  /** Recent error/warning toasts captured on the page, newest last. */
  recentErrors?: string[];
};

export type ChatRequest = {
  sessionId: string;
  /** The user's question. Ignored when `continuation` is set. */
  message: string;
  /** Prior turns for multi-turn context. */
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** Grafana page context used to enrich the system/user prompt. */
  pageContext?: PageContext;
  /** Tools this frontend can execute in the page (advertised every request). */
  browserTools?: BrowserToolSpec[];
  /** Opaque resume token from a `paused` event; resumes that turn. */
  continuation?: string;
  /** Results of the browser tool calls the paused turn asked for. */
  toolResults?: BrowserToolResult[];
};

/* ---- Suggestions (POST /resources/suggestions) ---- */

/**
 * Request for dynamic, LLM-generated follow-up suggestions. Sent after a turn
 * settles (or on load, with only page context). The backend runs a single,
 * tool-less model call over the recent conversation and returns short prompts
 * the user is likely to want next.
 */
export type SuggestionsRequest = {
  /** Recent conversation, oldest first (the frontend caps this, e.g. last 10). */
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** Grafana page context so suggestions stay grounded in what's on screen. */
  pageContext?: PageContext;
  /** Free-text guidance the user has given us to steer suggestions. */
  customContext?: string;
};

export type SuggestionsResponse = {
  suggestions: string[];
};

/** A tool the frontend executes in the user's page (namespaced browser__ server-side). */
export type BrowserToolSpec = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

/** Outcome of one browser-executed tool call, echoed back on continuation. */
export type BrowserToolResult = {
  id: string;
  content: string;
  isError?: boolean;
};

/* ---- Backend -> Frontend (SSE `data:` payloads) ---- */

export type ToolCallStatus = 'running' | 'completed' | 'error';

export type AgentEvent =
  /** A chunk of the assistant's visible answer. */
  | { type: 'content'; text: string }
  /** A chunk of the model's reasoning/thinking, if enabled. */
  | { type: 'reasoning'; text: string }
  /** The agent decided to call an MCP tool. */
  | { type: 'tool_call'; id: string; server: string; name: string; input: unknown; status: 'running' }
  /** An MCP tool returned (or errored). `output` is the full (UI-capped) result payload. */
  | { type: 'tool_result'; id: string; status: 'completed' | 'error'; preview?: string; output?: string; error?: string }
  /** The agent wants this frontend to execute a tool in the page. */
  | { type: 'browser_tool_call'; id: string; server: 'browser'; name: string; input: unknown; status: 'running' }
  /** The turn paused on browser tools; resume by POSTing the continuation + results. */
  | { type: 'paused'; continuation: string }
  /** Progress marker for long multi-step loops. */
  | { type: 'status'; text: string }
  /** Terminal success event. Text was streamed via `content`; `content` here is optional. */
  | { type: 'done'; content?: string }
  /** Terminal error event. */
  | { type: 'error'; error: string };

export function parseAgentEvent(data: string): AgentEvent | null {
  try {
    const parsed: unknown = JSON.parse(data);
    if (typeof parsed === 'object' && parsed !== null && typeof (parsed as { type?: unknown }).type === 'string') {
      return parsed as AgentEvent;
    }
  } catch {
    /* ignore malformed SSE payloads */
  }
  return null;
}
