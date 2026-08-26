import { useCallback, useEffect, useRef, useState } from 'react';
import { AgentEvent, BrowserToolResult, ChatRequest, PageContext } from '../lib/protocol';
import { streamChat } from '../lib/chat-stream';
import { browserToolSpecs, executeBrowserTool } from '../lib/browser-tools/registry';
import { extractPageContext } from '../lib/page-context';
import { loadAutoAllow, setAutoAllow } from '../lib/chat-store';
import {
  ChatTimelineEntry,
  appendStreamedText,
  appendToolEntry,
  replaceTrailingText,
} from '../lib/chat-timeline';
/**
 * A single item in the rendered conversation. Tool calls are tracked inline so
 * the UI can show a live "thinking" trace beneath the assistant's answer.
 */
export type ChatToolCall = {
  id: string;
  server: string;
  name: string;
  status: 'running' | 'completed' | 'error';
  /** The JSON arguments the model called the tool with. */
  input?: unknown;
  preview?: string;
  /** Full (backend-capped) tool result payload, rendered as JSON when possible. */
  output?: string;
  error?: string;
};

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** Streamed model reasoning shown inside the collapsible thinking block. */
  reasoning: string;
  toolCalls: ChatToolCall[];
  /**
   * Prose, reasoning, and tool calls in the order they actually happened.
   * `content` and `reasoning` remain the flat concatenations of the same
   * stream — they feed the backend transcript, the chat title, and copy.
   */
  timeline: ChatTimelineEntry[];
  status?: string;
  streaming: boolean;
};

/**
 * An interaction the agent requested from the human mid-turn. Rendered by the
 * chat panel as inline chips; answering resumes the paused agent loop.
 */
export type PendingInteraction =
  | { kind: 'question'; prompt: string; options?: string[] }
  | {
      kind: 'confirm';
      description: string;
      /** Tool being gated, shown as the label on the rendered arguments. */
      toolName: string;
      /** Raw arguments, rendered as pretty-printed JSON in the prompt. */
      input: Record<string, unknown>;
    };

let idCounter = 0;
const nextId = (): string => `${Date.now()}-${idCounter++}`;

/** Safety cap on continuation round-trips within one logical user turn. */
const MAX_CONTINUATIONS = 12;

/** Per-tool-error length cap in the replayed transcript, to bound prompt size. */
const HISTORY_ERROR_MAX = 400;

/**
 * Appends a UI-authored note (a backend error, an aborted-turn explanation) to
 * both the flat `content` and the timeline.
 *
 * These have to stay in lockstep: `content` is what the next turn's transcript
 * and "copy answer" see, while the timeline is what actually renders. Writing to
 * only one of them is how a note becomes invisible or, worse, invisible on
 * screen but present in the model's history.
 */
function withNote(args: { message: ChatMessage; note: string }): ChatMessage {
  const { message, note } = args;
  const separator = message.content ? '\n\n' : '';
  return {
    ...message,
    content: `${message.content}${separator}${note}`,
    timeline: appendStreamedText({
      timeline: message.timeline,
      kind: 'text',
      text: `${separator}${note}`,
    }),
  };
}

/**
 * Renders a message for the backend transcript, appending a note for any tool
 * call that failed.
 *
 * The wire format carries plain text only, so without this a prior turn where
 * `update_panel_query` errored looks — to the model — like a turn where it
 * successfully updated the panel and said so. That is exactly how a false claim
 * ("I've switched the datasource") survives into later turns.
 */
function withToolOutcomes(message: ChatMessage): string {
  const failed = message.toolCalls.filter((tc) => tc.status === 'error');
  if (failed.length === 0) {
    return message.content;
  }
  const notes = failed
    .map((tc) => {
      const reason = (tc.error ?? 'failed').slice(0, HISTORY_ERROR_MAX);
      return `- ${tc.name}: ${reason}`;
    })
    .join('\n');
  return (
    `${message.content}\n\n[system note: these tool calls FAILED in that turn, so any claim above that ` +
    `the page changed is wrong — correct it if the user follows up:\n${notes}]`
  ).trim();
}

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
  /**
   * Blanket "always allow" for confirmations. Scoped to this chat session and
   * persisted, so the standing approval survives a reload but never leaks into
   * another conversation. One click approves ALL later mutating tool calls in
   * this chat — per-tool scoping felt broken because every different UI action
   * asked again.
   */
  const autoAllowRef = useRef<boolean>(loadAutoAllow({ sessionId }));

  useEffect(() => {
    autoAllowRef.current = loadAutoAllow({ sessionId });
  }, [sessionId]);

  /** Resolve the pending question/confirmation with the user's answer. */
  const respond = useCallback((answer: string) => {
    const resolve = interactionResolveRef.current;
    interactionResolveRef.current = null;
    setInteraction(null);
    resolve?.(answer);
  }, []);

  const allowAlways = useCallback(() => {
    if (interaction?.kind === 'confirm') {
      autoAllowRef.current = true;
      setAutoAllow({ sessionId });
    }
    respond('yes');
  }, [interaction, respond, sessionId]);

  const send = useCallback(
    async (text: string, pageContext?: PageContext) => {
      if (!text.trim() || busy) {
        return;
      }
      /* History is text-only over the wire, so a failed action in a previous
       * turn would be invisible next turn — the model would only see its own
       * (possibly false) prose claim and happily reaffirm it. Fold failed tool
       * calls into the transcript so it can correct itself instead. */
      const history = messages
        .filter((m) => m.content.trim().length > 0 || m.toolCalls.some((tc) => tc.status === 'error'))
        .map((m) => ({ role: m.role, content: withToolOutcomes(m) }));

      const userMsg: ChatMessage = {
        id: nextId(),
        role: 'user',
        content: text,
        reasoning: '',
        toolCalls: [],
        timeline: [],
        streaming: false,
      };
      const assistantMsg: ChatMessage = {
        id: nextId(),
        role: 'assistant',
        content: '',
        reasoning: '',
        toolCalls: [],
        timeline: [],
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

      const confirm = async (args: {
        description: string;
        toolName: string;
        input: Record<string, unknown>;
      }): Promise<boolean> => {
        if (autoAllowRef.current) {
          return true;
        }
        const answer = await new Promise<string>((resolve) => {
          interactionResolveRef.current = resolve;
          setInteraction({
            kind: 'confirm',
            description: args.description,
            toolName: args.toolName,
            input: args.input,
          });
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
              patchAssistant((m) => ({
                ...m,
                content: m.content + event.text,
                timeline: appendStreamedText({ timeline: m.timeline, kind: 'text', text: event.text }),
              }));
              break;
            case 'reasoning':
              patchAssistant((m) => ({
                ...m,
                reasoning: m.reasoning + event.text,
                timeline: appendStreamedText({
                  timeline: m.timeline,
                  kind: 'reasoning',
                  text: event.text,
                }),
              }));
              break;
            case 'status':
              patchAssistant((m) => ({ ...m, status: event.text }));
              break;
            case 'tool_call':
              patchAssistant((m) => ({
                ...m,
                toolCalls: [
                  ...m.toolCalls,
                  { id: event.id, server: event.server, name: event.name, input: event.input, status: 'running' },
                ],
                timeline: appendToolEntry({ timeline: m.timeline, toolCallId: event.id }),
              }));
              break;
            case 'tool_result':
              patchToolCall(event.id, {
                status: event.status,
                preview: event.preview,
                output: event.output,
                error: event.error,
              });
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
                  { id: event.id, server: 'browser', name: event.name, input: event.input, status: 'running' },
                ],
                timeline: appendToolEntry({ timeline: m.timeline, toolCallId: event.id }),
              }));
              break;
            }
            case 'paused':
              continuation = event.continuation;
              break;
            case 'done':
              patchAssistant((m) => ({
                ...m,
                /* A `done` payload is a whole-answer replacement, so the
                 * timeline's trailing prose has to be replaced too, not appended
                 * to — otherwise the answer renders twice. */
                ...(event.content && event.content !== m.content
                  ? {
                      content: event.content,
                      timeline: replaceTrailingText({
                        timeline: m.timeline,
                        text: event.content,
                      }),
                    }
                  : {}),
                streaming: false,
                status: undefined,
              }));
              break;
            case 'error':
              /* Never discard a backend error just because prose already
               * streamed: `m.content || ...` used to drop it entirely, which is
               * how a confident answer survived a failed turn. */
              patchAssistant((m) =>
                withNote({
                  message: { ...m, streaming: false, status: undefined },
                  note: m.content ? `_Error: ${event.error}_` : `Error: ${event.error}`,
                }),
              );
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
            patchAssistant((m) =>
              withNote({
                message: { ...m, streaming: false, status: undefined },
                note: m.content ? '_Error: agent backend stream failed_' : 'Error: agent backend stream failed',
              }),
            );
          } else if (!continuation && pendingCalls.length > 0 && !controller.signal.aborted) {
            /* The turn asked for page actions but we never received the resume
             * token, so NONE of them ran. Silently returning here made the
             * assistant's "I've updated the panel" the only thing on screen. */
            patchAssistant((m) =>
              withNote({
                message: { ...m, streaming: false, status: undefined },
                note:
                  '_The page actions above were not performed (the agent stream ended without a ' +
                  'resume token), so nothing on the page changed. Please retry._',
              }),
            );
          }
          return;
        }

        if (depth >= MAX_CONTINUATIONS) {
          /* Same class of problem as the backend's tool-step budget: a bare
           * "(stopped)" told the user nothing about what did or did not happen
           * to their page. Name the cap, and say what state things are in. */
          patchAssistant((m) =>
            withNote({
              message: { ...m, streaming: false, status: undefined },
              note:
                `_I stopped here: this turn used all ${MAX_CONTINUATIONS} rounds of page actions ` +
                `I'm allowed, so I couldn't finish. The steps above did run, so the page reflects ` +
                `them — but treat anything I claimed beyond that as unverified. Ask again to ` +
                `continue from the current state._`,
            }),
          );
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
            output: outcome.isError ? undefined : outcome.content,
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

      try {
        await runStream(
          { sessionId, message: text, history, pageContext, browserTools: browserToolSpecs() },
          0,
        );
      } finally {
        /* Whatever happened (done, error, abort, thrown exception), the turn is
         * over: never leave the message flagged as streaming, or the UI shows a
         * permanent caret and persists the stuck flag to localStorage. */
        patchAssistant((m) => ({
          ...m,
          streaming: false,
          status: undefined,
          toolCalls: m.toolCalls.map((tc) =>
            tc.status === 'running' ? { ...tc, status: 'error', error: 'interrupted' } : tc,
          ),
        }));
        setBusy(false);
        abortRef.current = null;
      }
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
    /* Settle any message the aborted turn left mid-stream. */
    setMessages((prev) =>
      prev.map((m) =>
        m.streaming
          ? {
              ...m,
              streaming: false,
              status: undefined,
              toolCalls: m.toolCalls.map((tc) =>
                tc.status === 'running' ? { ...tc, status: 'error', error: 'cancelled' } : tc,
              ),
            }
          : m,
      ),
    );
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
