import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { css } from '@emotion/css';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { GrafanaTheme2 } from '@grafana/data';
import { useStyles2 } from '@grafana/ui';
import { ChatPanel } from './ChatPanel';
import { TopBarTrigger } from './TopBarTrigger';
import { Branding, loadBranding } from '../lib/branding';
import { drawerVariants } from '../lib/motion';

/**
 * Global entry point for the MCP agent, mounted into <body> on every Grafana
 * page (the plugin is preloaded). There is exactly one affordance — an icon
 * button in Grafana's top nav toolbar, rendered through a portal into a host
 * node we attach there (Grafana 13 gates every top-bar extension slot to an
 * internal plugin allow-list, so the node has to be attached by us).
 *
 * Opening it slides in a docked chat column on the right that PUSHES the page
 * content aside rather than overlaying it, so panels and query editors stay
 * interactive while chatting — the agent is meant to help edit the page itself.
 */

/** Width of the docked chat column; also used to shrink the app content. */
const PANEL_WIDTH = 440;
/** Host node for the portal; also the de-dupe key across module re-evaluation. */
const HOST_ID = 'mcpagent-topbar-slot';

export function TopBarChat() {
  const styles = useStyles2(getStyles);
  const reduceMotion = useReducedMotion();
  const [open, setOpen] = useState(false);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [branding, setBranding] = useState<Branding>({});

  /* Load operator branding once (cached); drives the trigger's custom icon. */
  useEffect(() => {
    let cancelled = false;
    void loadBranding().then((b) => {
      if (!cancelled) {
        setBranding(b);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /* Escape closes; the keyboard shortcut toggles from anywhere in Grafana (the
   * trigger can only exist once the chrome has rendered, and power users expect
   * not to reach for it). */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /* Push the page: shrink Grafana's app shell by the panel width while open, so
   * the docked chat sits beside the content instead of covering it. Restores
   * the original value on close/unmount. Transition matches the panel slide. */
  useEffect(() => {
    const shell = document.querySelector<HTMLElement>('.grafana-app') ?? document.body;
    const prevPadding = shell.style.paddingRight;
    const prevTransition = shell.style.transition;
    shell.style.transition = reduceMotion ? '' : 'padding-right 320ms cubic-bezier(0.22, 1, 0.36, 1)';
    shell.style.paddingRight = open ? `${PANEL_WIDTH}px` : prevPadding || '';
    return () => {
      shell.style.paddingRight = prevPadding;
      shell.style.transition = prevTransition;
    };
  }, [open, reduceMotion]);

  /**
   * Keep a portal host attached to the top nav toolbar. Grafana re-renders its
   * chrome on navigation (dropping our node), so a MutationObserver re-attaches
   * the *same* host element — React's portal content lives inside it and simply
   * comes back with it, so no chat state is lost.
   *
   * The callback must be cheap: dashboards, Explore and log views mutate <body>
   * thousands of times a second, so work is coalesced to one run per frame and
   * the common case exits after an `isConnected` check. Our own writes happen
   * with the observer detached so we can never observe ourselves into a loop.
   */
  useEffect(() => {
    const node = document.getElementById(HOST_ID) ?? createHost();

    let disposed = false;
    let frame = 0;
    const observer = new MutationObserver(() => schedule());

    const observe = () => {
      if (!disposed) {
        observer.observe(document.body, { childList: true, subtree: true });
      }
    };

    const attach = () => {
      if (disposed || node.isConnected) {
        return;
      }
      const toolbar = findToolbar();
      if (!toolbar) {
        return;
      }
      observer.disconnect();
      try {
        /* Appended last so it never lands between siblings React is tracking. */
        toolbar.appendChild(node);
      } finally {
        observe();
      }
      setHost((prev) => prev ?? node);
    };

    /** Coalesces a burst of mutations into a single check per frame. */
    const schedule = () => {
      if (frame !== 0 || disposed) {
        return;
      }
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        attach();
      });
    };

    attach();
    observe();
    return () => {
      disposed = true;
      if (frame !== 0) {
        window.cancelAnimationFrame(frame);
      }
      observer.disconnect();
    };
  }, []);

  return (
    <>
      {host &&
        createPortal(
          <TopBarTrigger
            open={open}
            branding={branding}
            shortcut={shortcutLabel()}
            onToggle={() => setOpen((v) => !v)}
          />,
          host,
        )}

      <AnimatePresence>
        {open && (
          <motion.aside
            key="panel"
            className={styles.panel}
            style={{ width: PANEL_WIDTH }}
            variants={drawerVariants}
            initial={reduceMotion ? false : 'hidden'}
            animate="visible"
            exit="exit"
            data-testid="mcpagent-drawer"
          >
            <ChatPanel compact onClose={() => setOpen(false)} />
          </motion.aside>
        )}
      </AnimatePresence>
    </>
  );
}

/**
 * Creates the portal host. `display: contents` makes the trigger button itself
 * the flex item inside Grafana's toolbar, so it aligns with the native controls
 * without an extra wrapper box.
 */
function createHost(): HTMLElement {
  const node = document.createElement('div');
  node.id = HOST_ID;
  node.style.display = 'contents';
  return node;
}

/**
 * Locates the top nav toolbar (the right-aligned Search / New / Help / Sign in
 * cluster). Only toolbar-scoped anchors are used: matching a generic "Search"
 * input would happily hit a filter field inside the page body.
 */
function findToolbar(): HTMLElement | null {
  const toolbar = document.querySelector<HTMLElement>('[data-testid="data-testid Nav toolbar"]');
  if (toolbar) {
    return toolbar;
  }
  const palette = document.querySelector<HTMLElement>('[data-testid="data-testid Command palette trigger"]');
  return palette?.parentElement ?? null;
}

/** Platform-correct rendering of the toggle shortcut for tooltips. */
function shortcutLabel(): string {
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent);
  return isMac ? '⌘⇧A' : 'Ctrl+Shift+A';
}

const getStyles = (theme: GrafanaTheme2) => ({
  panel: css({
    position: 'fixed',
    top: 0,
    right: 0,
    bottom: 0,
    zIndex: theme.zIndex.navbarFixed,
    display: 'flex',
    flexDirection: 'column',
    background: theme.colors.background.primary,
    borderLeft: `1px solid ${theme.colors.border.weak}`,
    boxShadow: '-8px 0 32px rgba(0,0,0,0.28)',
  }),
});
