import { useCallback, useRef, useState } from 'react';
import { AgentEvent, PageContext } from '../lib/protocol';
import { streamChat } from '../lib/chat-stream';

/**
 * A single item in the rendered conversation. Tool calls are tracked inline so
 * the UI can show a live "thinking" trace beneath the assistant's answer.
 */
export type ChatToolCall = {
  id: string;
  server: string;
  name: string;
  status: 'running' | 'completed' | 'error';
  preview?: string;
  error?: string;
};

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls: ChatToolCall[];
  status?: string;
  streaming: boolean;
};

let idCounter = 0;
const nextId = (): string => `${Date.now()}-${idCounter++}`;

/**
 * useAgentChat owns conversation state and the SSE lifecycle for one session.
 */
export function useAgentChat(sessionId: string) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const send = useCallback(
    async (text: string, pageContext?: PageContext) => {
      if (!text.trim() || busy) {
        return;
      }
      const history = messages
        .filter((m) => m.content.trim().length > 0)
        .map((m) => ({ role: m.role, content: m.content }));

      const userMsg: ChatMessage = {
        id: nextId(),
        role: 'user',
        content: text,
        toolCalls: [],
        streaming: false,
      };
      const assistantMsg: ChatMessage = {
        id: nextId(),
        role: 'assistant',
        content: '',
        toolCalls: [],
        streaming: true,
      };
      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setBusy(true);

      const controller = new AbortController();
      abortRef.current = controller;

      const patchAssistant = (fn: (m: ChatMessage) => ChatMessage) => {
        setMessages((prev) => prev.map((m) => (m.id === assistantMsg.id ? fn(m) : m)));
      };

      const onEvent = (event: AgentEvent) => {
        switch (event.type) {
          case 'content':
            patchAssistant((m) => ({ ...m, content: m.content + event.text }));
            break;
          case 'status':
            patchAssistant((m) => ({ ...m, status: event.text }));
            break;
          case 'tool_call':
            patchAssistant((m) => ({
              ...m,
              toolCalls: [
                ...m.toolCalls,
                { id: event.id, server: event.server, name: event.name, status: 'running' },
              ],
            }));
            break;
          case 'tool_result':
            patchAssistant((m) => ({
              ...m,
              toolCalls: m.toolCalls.map((tc) =>
                tc.id === event.id
                  ? { ...tc, status: event.status, preview: event.preview, error: event.error }
                  : tc,
              ),
            }));
            break;
          case 'done':
            patchAssistant((m) => ({
              ...m,
              content: event.content || m.content,
              streaming: false,
              status: undefined,
            }));
            break;
          case 'error':
            patchAssistant((m) => ({
              ...m,
              content: m.content || `Error: ${event.error}`,
              streaming: false,
              status: undefined,
            }));
            break;
          default:
            break;
        }
      };

      await streamChat(
        { sessionId, message: text, history, pageContext },
        {
          onEvent,
          onDone: () => {
            patchAssistant((m) => ({ ...m, streaming: false, status: undefined }));
            setBusy(false);
            abortRef.current = null;
          },
          onError: (err) => {
            patchAssistant((m) => ({
              ...m,
              content: m.content || `Error: ${err.message}`,
              streaming: false,
              status: undefined,
            }));
            setBusy(false);
            abortRef.current = null;
          },
        },
        controller.signal,
      );
    },
    [busy, messages, sessionId],
  );

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(false);
  }, []);

  const reset = useCallback(() => {
    cancel();
    setMessages([]);
  }, [cancel]);

  return { messages, busy, send, cancel, reset };
}
