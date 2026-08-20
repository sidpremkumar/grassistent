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
};

export type ChatRequest = {
  sessionId: string;
  message: string;
  /** Prior turns for multi-turn context. */
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** Grafana page context used to enrich the system/user prompt. */
  pageContext?: PageContext;
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
  /** An MCP tool returned (or errored). */
  | { type: 'tool_result'; id: string; status: 'completed' | 'error'; preview?: string; error?: string }
  /** Progress marker for long multi-step loops. */
  | { type: 'status'; text: string }
  /** Terminal success event; `content` holds the full final answer. */
  | { type: 'done'; content: string }
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
