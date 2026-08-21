import { ChatMessage } from '../components/use-agent-chat';

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
    return parsed;
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

/**
 * Loads the user's free-text custom context — guidance they've given us to
 * steer suggestions (e.g. "I own the checkout service; focus on latency").
 * Stored separately from chat history since it spans all sessions.
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

/** Persists the user's custom context. Best-effort; ignores quota errors. */
export function saveCustomContext(value: string): void {
  if (typeof localStorage === 'undefined') {
    return;
  }
  try {
    localStorage.setItem(CUSTOM_CONTEXT_KEY, value);
  } catch {
    /* quota exceeded or unavailable */
  }
}

const AUTO_ALLOW_KEY = 'mcpagent.autoAllow.v1';

/** Tool names the user chose to always allow, keyed by chat session id. */
type AutoAllowStore = Record<string, string[]>;

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
 * Tools the user has blanket-approved *for this chat only*. Deliberately scoped
 * per session so a standing approval in one investigation never silently
 * carries into an unrelated thread.
 */
export function loadAutoAllow(args: { sessionId: string }): string[] {
  return loadAutoAllowStore()[args.sessionId] ?? [];
}

/** Remembers "always allow" for one tool within one chat. */
export function addAutoAllow(args: { sessionId: string; toolName: string }): void {
  const store = loadAutoAllowStore();
  const current = store[args.sessionId] ?? [];
  if (current.includes(args.toolName)) {
    return;
  }
  saveAutoAllowStore({ ...store, [args.sessionId]: [...current, args.toolName] });
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
