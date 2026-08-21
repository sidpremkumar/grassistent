import { useCallback, useEffect, useState } from 'react';
import { loadCustomContext, saveCustomContext, subscribeCustomContext } from './chat-store';

/**
 * Standing user preferences ("steer suggestions") as a single source of truth.
 *
 * The chat panel is unmounted whenever the drawer closes, so the value cannot
 * live in component state alone: it is hydrated from localStorage on mount,
 * written through on every edit, and kept in lockstep with any other live panel
 * or Grafana tab via `subscribeCustomContext`. The net effect for the user is a
 * preference that looks identical across chats, navigations, and reloads.
 */
export function useCustomContext(): { value: string; setValue: (next: string) => void } {
  const [value, setLocal] = useState<string>(() => loadCustomContext());

  const setValue = useCallback((next: string) => {
    setLocal(next);
    saveCustomContext(next);
  }, []);

  /* Adopt edits made elsewhere. Guarded on inequality so our own write-through
   * (which broadcasts too) can't bounce back and fight the user's typing. */
  useEffect(() => {
    return subscribeCustomContext({
      onChange: (next) => setLocal((prev) => (prev === next ? prev : next)),
    });
  }, []);

  /* localStorage may have been written between render and effect-flush (e.g. a
   * second panel mounting in the same frame); re-read once to settle. */
  useEffect(() => {
    const stored = loadCustomContext();
    setLocal((prev) => (prev === stored ? prev : stored));
  }, []);

  return { value, setValue };
}
