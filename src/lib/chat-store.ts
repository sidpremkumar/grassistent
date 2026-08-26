import { ChatMessage, ChatToolCall } from '../components/use-agent-chat';
import { legacyTimeline } from './chat-timeline';

/**
 * Local-storage backed persistence for chat sessions. Conversations live only
 * in the browser (no server-side history), so users can reopen the drawer and
 * scroll back through prior investigations, or jump between separate threads.
 *
 * A single JSON blob under one key keeps reads/writes simple and atomic; chat
 * volumes are small (text only) so this is well within localStorage limits.
 */

const STORAGE_KEY = 'mcpagent.chat.v1';
const MAX_SESSIONS = 50;

export type ChatSession = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
};

type Store = {
  sessions: ChatSession[];
  activeId: string | null;
};

const emptyStore = (): Store => ({ sessions: [], activeId: null });

/**
 * Persisted messages can never legitimately be mid-stream: the store is
 * written on every stream chunk, so a turn interrupted by a reload, drawer
 * close, or crash leaves `streaming: true` frozen in localStorage. Rendering
 * that would show a permanent blinking caret on old messages, so settle
 * everything on load: finish the message and mark still-"running" tool calls
 * as errored (they will never complete).
 *
 * This is also where messages written before the timeline existed are migrated,
 * so old threads keep rendering instead of collapsing to a bare answer.
 */
function settleMessage(message: ChatMessage): ChatMessage {
  const timeline =
    message.timeline && message.timeline.length > 0
      ? message.timeline
      : legacyTimeline({
          reasoning: message.reasoning ?? '',
          content: message.content ?? '',
          toolCallIds: (message.toolCalls ?? []).map((tc) => tc.id),
        });

  if (
    !message.streaming &&
    (message.toolCalls ?? []).every((tc) => tc.status !== 'running') &&
    timeline === message.timeline
  ) {
    return message;
  }
  const toolCalls: ChatToolCall[] = (message.toolCalls ?? []).map((tc) =>
    tc.status === 'running' ? { ...tc, status: 'error', error: 'interrupted' } : tc,
  );
  return { ...message, streaming: false, status: undefined, toolCalls, timeline };
}

/** Reads and validates the persisted store, tolerating corruption. */
export function loadStore(): Store {
  if (typeof localStorage === 'undefined') {
    return emptyStore();
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return emptyStore();
    }
    const parsed = JSON.parse(raw) as Store;
    if (!parsed || !Array.isArray(parsed.sessions)) {
      return emptyStore();
    }
    return {
      activeId: parsed.activeId,
      sessions: parsed.sessions.map((s) => ({
        ...s,
        messages: Array.isArray(s.messages) ? s.messages.map(settleMessage) : [],
      })),
    };
  } catch {
    return emptyStore();
  }
}

/** Persists the store, trimming to the most recently updated sessions. */
export function saveStore(store: Store): void {
  if (typeof localStorage === 'undefined') {
    return;
  }
  const trimmed: Store = {
    activeId: store.activeId,
    sessions: [...store.sessions]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_SESSIONS),
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    /* quota exceeded or unavailable; history is best-effort */
  }
}

const CUSTOM_CONTEXT_KEY = 'mcpagent.customContext.v1';
/** In-page notification channel; `storage` only fires in *other* tabs. */
const CUSTOM_CONTEXT_EVENT = 'mcpagent:customContext';

/**
 * Loads the user's standing preferences — free-text guidance that steers
 * suggestions (e.g. "I own the checkout service; focus on latency").
 *
 * Deliberately stored outside the chat blob and keyed on its own: this is a
 * long-lived user preference, so it must survive reloads, new chats, deleting
 * history, and switching between threads.
 */
export function loadCustomContext(): string {
  if (typeof localStorage === 'undefined') {
    return '';
  }
  try {
    return localStorage.getItem(CUSTOM_CONTEXT_KEY) ?? '';
  } catch {
    return '';
  }
}

/**
 * Persists the preference and announces it, so every mounted panel (the drawer
 * can be torn down and rebuilt, and more than one surface may be live) shows
 * the same value instead of a stale copy from its own mount. Best-effort;
 * ignores quota errors.
 */
export function saveCustomContext(value: string): void {
  if (typeof localStorage === 'undefined') {
    return;
  }
  try {
    localStorage.setItem(CUSTOM_CONTEXT_KEY, value);
  } catch {
    /* quota exceeded or unavailable */
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<string>(CUSTOM_CONTEXT_EVENT, { detail: value }));
  }
}

/**
 * Subscribes to preference changes from anywhere else — another panel instance
 * in this tab (custom event) or another Grafana tab (native `storage` event).
 * Returns an unsubscribe function.
 */
export function subscribeCustomContext(args: { onChange: (value: string) => void }): () => void {
  if (typeof window === 'undefined') {
    return () => undefined;
  }
  const onLocal = (e: Event) => {
    const detail = (e as CustomEvent<string>).detail;
    args.onChange(typeof detail === 'string' ? detail : loadCustomContext());
  };
  const onStorage = (e: StorageEvent) => {
    /* key === null means the whole store was cleared. */
    if (e.key !== null && e.key !== CUSTOM_CONTEXT_KEY) {
      return;
    }
    args.onChange(e.key === null ? '' : e.newValue ?? '');
  };
  window.addEventListener(CUSTOM_CONTEXT_EVENT, onLocal);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(CUSTOM_CONTEXT_EVENT, onLocal);
    window.removeEventListener('storage', onStorage);
  };
}

const AUTO_ALLOW_KEY = 'mcpagent.autoAllow.v2';

/**
 * Chats where the user granted a blanket "always allow" for mutating tools.
 * One click covers every subsequent confirmation in that conversation — the
 * approval is for "let the agent drive this chat", not for one tool name
 * (which felt broken: each different UI action would ask again).
 */
type AutoAllowStore = Record<string, true>;

function loadAutoAllowStore(): AutoAllowStore {
  if (typeof localStorage === 'undefined') {
    return {};
  }
  try {
    const raw = localStorage.getItem(AUTO_ALLOW_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as AutoAllowStore;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveAutoAllowStore(store: AutoAllowStore): void {
  if (typeof localStorage === 'undefined') {
    return;
  }
  try {
    localStorage.setItem(AUTO_ALLOW_KEY, JSON.stringify(store));
  } catch {
    /* quota exceeded or unavailable; approvals just fall back to asking */
  }
}

/**
 * Whether the user blanket-approved mutating tools *for this chat only*.
 * Deliberately scoped per session so a standing approval in one investigation
 * never silently carries into an unrelated thread.
 */
export function loadAutoAllow(args: { sessionId: string }): boolean {
  return loadAutoAllowStore()[args.sessionId] === true;
}

/** Remembers "always allow" for the rest of one chat. */
export function setAutoAllow(args: { sessionId: string }): void {
  const store = loadAutoAllowStore();
  if (store[args.sessionId]) {
    return;
  }
  saveAutoAllowStore({ ...store, [args.sessionId]: true });
}

/** Drops a chat's standing approvals, e.g. when the conversation is deleted. */
export function clearAutoAllow(args: { sessionId: string }): void {
  const store = loadAutoAllowStore();
  if (!(args.sessionId in store)) {
    return;
  }
  const next: AutoAllowStore = { ...store };
  delete next[args.sessionId];
  saveAutoAllowStore(next);
}

export function genSessionId(): string {  return `sess-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

export function newSession(): ChatSession {
  const now = Date.now();
  return { id: genSessionId(), title: 'New chat', createdAt: now, updatedAt: now, messages: [] };
}

/**
 * Derives a short human title from the first user message, so the history list
 * is scannable without the user naming each thread.
 */
export function deriveTitle(messages: ChatMessage[]): string {
  const firstUser = messages.find((m) => m.role === 'user' && m.content.trim().length > 0);
  if (!firstUser) {
    return 'New chat';
  }
  const text = firstUser.content.trim().replace(/\s+/g, ' ');
  return text.length > 42 ? `${text.slice(0, 42)}…` : text;
}
