import { AgentEvent, ChatRequest, parseAgentEvent } from './protocol';

/**
 * Streams a chat turn from the plugin's Go backend over SSE.
 *
 * The backend runs the agent loop (Bedrock Converse + MCP tools) and emits
 * `AgentEvent`s. We hit the Grafana plugin resource route, which is same-origin
 * and carries the user's Grafana session, so no secret is exposed to the page.
 */

const PLUGIN_ID = 'mcpagent-app';
const RESOURCE_URL = `/api/plugins/${PLUGIN_ID}/resources/chat`;

export type ChatStreamHandlers = {
  onEvent: (event: AgentEvent) => void;
  onDone?: () => void;
  onError?: (err: Error) => void;
};

export async function streamChat(
  request: ChatRequest,
  handlers: ChatStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(RESOURCE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(request),
      signal,
    });
  } catch (err) {
    handlers.onError?.(err instanceof Error ? err : new Error(String(err)));
    return;
  }

  if (!response.ok || !response.body) {
    handlers.onError?.(new Error(`Agent backend returned ${response.status}`));
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });

      /* SSE frames are separated by a blank line. */
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const dataLine = frame
          .split('\n')
          .find((line) => line.startsWith('data:'));
        if (!dataLine) {
          continue;
        }
        const event = parseAgentEvent(dataLine.slice('data:'.length).trim());
        if (event) {
          handlers.onEvent(event);
        }
      }
    }
    handlers.onDone?.();
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      handlers.onDone?.();
      return;
    }
    handlers.onError?.(err instanceof Error ? err : new Error(String(err)));
  } finally {
    reader.releaseLock();
  }
}
