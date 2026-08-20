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

export function genSessionId(): string {
  return `sess-${Math.random().toString(36).slice(2)}-${Date.now()}`;
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
