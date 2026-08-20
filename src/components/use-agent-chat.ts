import { useCallback, useRef, useState } from 'react';
import { AgentEvent, BrowserToolResult, ChatRequest, PageContext } from '../lib/protocol';
import { streamChat } from '../lib/chat-stream';
import { browserToolSpecs, executeBrowserTool } from '../lib/browser-tools/registry';
import { extractPageContext } from '../lib/page-context';

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
  /** Streamed model reasoning shown inside the collapsible thinking block. */
  reasoning: string;
  toolCalls: ChatToolCall[];
  status?: string;
  streaming: boolean;
};

/**
 * An interaction the agent requested from the human mid-turn. Rendered by the
 * chat panel as inline chips; answering resumes the paused agent loop.
 */
export type PendingInteraction =
  | { kind: 'question'; prompt: string; options?: string[] }
  | { kind: 'confirm'; description: string };

let idCounter = 0;
const nextId = (): string => `${Date.now()}-${idCounter++}`;

/** Safety cap on continuation round-trips within one logical user turn. */
const MAX_CONTINUATIONS = 12;

/**
 * useAgentChat owns conversation state and the SSE lifecycle for one session,
 * including the pause/execute/continue loop for browser tools: when the
 * backend pauses on `browser_tool_call`s, this hook executes them in the page
 * (gating mutations behind confirmation), re-extracts the page context so the
 * model can observe the effect of its actions, and resumes the turn.
 */
export function useAgentChat(sessionId: string, initialMessages: ChatMessage[] = []) {
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [busy, setBusy] = useState(false);
  const [interaction, setInteraction] = useState<PendingInteraction | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const interactionResolveRef = useRef<((answer: string) => void) | null>(null);
  /** "Always allow" toggle for confirmations, scoped to this hook instance. */
  const autoAllowRef = useRef(false);

  /** Resolve the pending question/confirmation with the user's answer. */
  const respond = useCallback((answer: string) => {
    const resolve = interactionResolveRef.current;
    interactionResolveRef.current = null;
    setInteraction(null);
    resolve?.(answer);
  }, []);

  const allowAlways = useCallback(() => {
    autoAllowRef.current = true;
    respond('yes');
  }, [respond]);

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
        reasoning: '',
        toolCalls: [],
        streaming: false,
      };
      const assistantMsg: ChatMessage = {
        id: nextId(),
        role: 'assistant',
        content: '',
        reasoning: '',
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

      const patchToolCall = (id: string, patch: Partial<ChatToolCall>) => {
        patchAssistant((m) => ({
          ...m,
          toolCalls: m.toolCalls.map((tc) => (tc.id === id ? { ...tc, ...patch } : tc)),
        }));
      };

      /* Interaction plumbing handed to browser tools (ask_user + confirm). */
      const promptUser = (args: { prompt: string; options?: string[] }): Promise<string> =>
        new Promise<string>((resolve) => {
          interactionResolveRef.current = resolve;
          setInteraction({ kind: 'question', prompt: args.prompt, options: args.options });
        });

      const confirm = async (args: { description: string }): Promise<boolean> => {
        if (autoAllowRef.current) {
          return true;
        }
        const answer = await new Promise<string>((resolve) => {
          interactionResolveRef.current = resolve;
          setInteraction({ kind: 'confirm', description: args.description });
        });
        return answer === 'yes';
      };

      /**
       * Runs one SSE stream and, if it pauses on browser tools, executes them
       * and recurses with the continuation until the turn truly finishes.
       */
      const runStream = async (request: ChatRequest, depth: number): Promise<void> => {
        let continuation: string | null = null;
        const pendingCalls: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];

        const onEvent = (event: AgentEvent) => {
          switch (event.type) {
            case 'content':
              patchAssistant((m) => ({ ...m, content: m.content + event.text }));
              break;
            case 'reasoning':
              patchAssistant((m) => ({ ...m, reasoning: m.reasoning + event.text }));
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
              patchToolCall(event.id, { status: event.status, preview: event.preview, error: event.error });
              break;
            case 'browser_tool_call': {
              const input =
                typeof event.input === 'object' && event.input !== null
                  ? (event.input as Record<string, unknown>)
                  : {};
              pendingCalls.push({ id: event.id, name: event.name, input });
              patchAssistant((m) => ({
                ...m,
                toolCalls: [
                  ...m.toolCalls,
                  { id: event.id, server: 'browser', name: event.name, status: 'running' },
                ],
              }));
              break;
            }
            case 'paused':
              continuation = event.continuation;
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

        let streamFailed = false;
        await streamChat(request, {
          onEvent,
          onError: () => {
            streamFailed = true;
          },
        }, controller.signal);

        if (streamFailed || !continuation || pendingCalls.length === 0 || controller.signal.aborted) {
          if (streamFailed) {
            patchAssistant((m) => ({
              ...m,
              content: m.content || 'Error: agent backend stream failed',
              streaming: false,
              status: undefined,
            }));
          }
          return;
        }

        if (depth >= MAX_CONTINUATIONS) {
          patchAssistant((m) => ({
            ...m,
            content: `${m.content}\n\n_(stopped: too many browser tool rounds)_`,
            streaming: false,
            status: undefined,
          }));
          return;
        }

        /* Execute the requested browser tools sequentially in the page. */
        patchAssistant((m) => ({ ...m, status: 'Acting on the page…' }));
        const results: BrowserToolResult[] = [];
        for (const call of pendingCalls) {
          if (controller.signal.aborted) {
            return;
          }
          const outcome = await executeBrowserTool({
            name: call.name,
            input: call.input,
            ctx: { promptUser, confirm },
          });
          patchToolCall(call.id, {
            status: outcome.isError ? 'error' : 'completed',
            preview: outcome.isError ? undefined : outcome.content,
            error: outcome.isError ? outcome.content : undefined,
          });
          results.push({ id: call.id, content: outcome.content, isError: outcome.isError });
        }

        /* Let the page settle, then observe it so the model sees its effects. */
        await new Promise((resolve) => window.setTimeout(resolve, 600));
        const freshContext = await extractPageContext();

        patchAssistant((m) => ({ ...m, status: 'Thinking…' }));
        await runStream(
          {
            sessionId,
            message: '',
            continuation,
            toolResults: results,
            browserTools: browserToolSpecs(),
            pageContext: freshContext,
          },
          depth + 1,
        );
      };

      await runStream(
        { sessionId, message: text, history, pageContext, browserTools: browserToolSpecs() },
        0,
      );

      patchAssistant((m) => ({ ...m, streaming: false, status: undefined }));
      setBusy(false);
      abortRef.current = null;
    },
    [busy, messages, sessionId],
  );

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    /* Unblock any tool waiting on the human so the turn can unwind. */
    interactionResolveRef.current?.('cancelled');
    interactionResolveRef.current = null;
    setInteraction(null);
    setBusy(false);
  }, []);

  const reset = useCallback(() => {
    cancel();
    setMessages([]);
  }, [cancel]);

  /** Replaces the conversation, e.g. when switching to a persisted session. */
  const load = useCallback(
    (msgs: ChatMessage[]) => {
      cancel();
      setMessages(msgs);
    },
    [cancel],
  );

  return { messages, busy, interaction, respond, allowAlways, send, cancel, reset, load };
}
