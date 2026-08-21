import { useEffect, useState } from 'react';
import { css } from '@emotion/css';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { GrafanaTheme2 } from '@grafana/data';
import { Icon, useStyles2 } from '@grafana/ui';
import { ChatPanel } from './ChatPanel';
import { Branding, isSafeIconSrc, loadBranding } from '../lib/branding';
import { drawerVariants, fabVariants } from '../lib/motion';

/**
 * Global entry point for the MCP agent, mounted into <body> on every Grafana
 * page (the plugin is preloaded). It renders:
 *  - a trigger button injected into the top bar, next to the Search / Sign in
 *    cluster (Grafana 13 blocks third-party plugins from the top-bar extension
 *    slots, so we attach the button to the DOM ourselves), and
 *  - a docked chat panel on the right that PUSHES the page content aside rather
 *    than overlaying it, so the user can keep interacting with panels and query
 *    editors while chatting (the agent is meant to help edit the page itself).
 *
 * A floating action button is kept as a resilient fallback for the case where
 * the top-bar markup changes and the injection can't find its anchor.
 */

const TOGGLE_EVENT = 'mcpagent:toggle';
/** Width of the docked chat column; also used to shrink the app content. */
const PANEL_WIDTH = 440;

export function FloatingChat() {
  const styles = useStyles2(getStyles);
  const reduceMotion = useReducedMotion();
  const [open, setOpen] = useState(false);
  const [injected, setInjected] = useState(false);
  const [branding, setBranding] = useState<Branding>({});

  /* Load operator branding once (cached); drives the custom icon on the
   * top-bar button and the FAB fallback. */
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

  /* Toggle from either the injected top-bar button or the fallback FAB. */
  useEffect(() => {
    const onToggle = () => setOpen((v) => !v);
    window.addEventListener(TOGGLE_EVENT, onToggle);
    return () => window.removeEventListener(TOGGLE_EVENT, onToggle);
  }, []);

  /* Close on Escape. */
  useEffect(() => {
    if (!open) {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

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
   * Inject a trigger button into the top bar. Grafana re-renders the chrome on
   * navigation, so a MutationObserver keeps the button present.
   *
   * Two hazards here both lock up the tab, and both are guarded below:
   *
   *  1. Self-observation. Our own DOM writes are seen by the observer, and
   *     `innerHTML` is NOT round-trip stable: the parser re-serializes
   *     `<path … />` as `<path …></path>`, so a naive "rewrite when it differs"
   *     check never converges — write → mutation → still differs → write …
   *     forever, in a microtask loop that starves rendering. We therefore
   *     compare a `data-icon-key` marker (what we last applied) instead of the
   *     serialized markup, and detach the observer around our own writes.
   *
   *  2. Callback cost. Dashboards, Explore, and log views mutate <body>
   *     thousands of times a second (panel renders, log rows, tooltips), so the
   *     callback must be cheap: work is coalesced to at most one run per frame,
   *     and the common case exits after a single `getElementById`.
   */
  useEffect(() => {
    const BTN_ID = 'mcpagent-topbar-trigger';

    /* Custom icon (if configured + safe) renders as an <img>; otherwise the
     * built-in inline SVG glyph. */
    const customIcon = isSafeIconSrc(branding.icon) ? branding.icon : undefined;
    const innerHTML = customIcon
      ? `<img src="${escapeAttr(customIcon)}" alt="" width="18" height="18" style="display:block;object-fit:contain;border-radius:4px" />`
      : triggerInnerHTML;
    /* Stable identity of the rendered content, safe to compare across reads. */
    const iconKey = customIcon ?? 'builtin';

    /* Finds the top-bar search control; the button is inserted just before it so
     * it sits in the same right-aligned cluster as Search / Sign in. Grafana's
     * markup varies by version, so several selectors are tried in order. */
    const findSearch = (): Element | null =>
      document.querySelector('[data-testid="data-testid Nav toolbar search"]') ??
      document.querySelector('button[aria-label="Search or jump to..."]') ??
      document.querySelector('[aria-label^="Search or jump"]') ??
      document.querySelector('input[placeholder^="Search"]') ??
      document.querySelector('[placeholder^="Search"]');

    let disposed = false;
    let frame = 0;
    const observer = new MutationObserver(() => schedule());

    const observe = () => {
      if (!disposed) {
        observer.observe(document.body, { childList: true, subtree: true });
      }
    };

    /** Runs our own DOM writes with the observer detached. */
    const writeDom = (mutate: () => void) => {
      observer.disconnect();
      try {
        mutate();
      } finally {
        observe();
      }
    };

    /* Never re-render for an unchanged value: this runs on DOM churn. */
    const setPresent = (present: boolean) => {
      setInjected((prev) => (prev === present ? prev : present));
    };

    const tryInject = () => {
      if (disposed) {
        return;
      }
      const existing = document.getElementById(BTN_ID);
      if (existing) {
        /* Keep the icon in sync if branding loaded after the button mounted. */
        if (existing.dataset.iconKey !== iconKey) {
          writeDom(() => {
            existing.dataset.iconKey = iconKey;
            existing.innerHTML = innerHTML;
          });
        }
        setPresent(true);
        return;
      }
      const search = findSearch();
      /* The search control's parent is the flex cell in the top-bar cluster. */
      const cell = search?.parentElement ?? null;
      const cluster = cell?.parentElement ?? null;
      if (!cell || !cluster) {
        setPresent(false);
        return;
      }
      const btn = document.createElement('button');
      btn.id = BTN_ID;
      btn.type = 'button';
      btn.setAttribute('aria-label', 'Open MCP Agent');
      btn.title = 'MCP Agent';
      btn.className = mcpTriggerClass;
      btn.dataset.iconKey = iconKey;
      btn.innerHTML = innerHTML;
      btn.addEventListener('click', () => window.dispatchEvent(new CustomEvent(TOGGLE_EVENT)));
      /* Insert immediately before the search cluster. */
      writeDom(() => cluster.insertBefore(btn, cell));
      setPresent(true);
    };

    /** Coalesces a burst of mutations into a single check per frame. */
    const schedule = () => {
      if (frame !== 0 || disposed) {
        return;
      }
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        tryInject();
      });
    };

    tryInject();
    observe();
    return () => {
      disposed = true;
      if (frame !== 0) {
        window.cancelAnimationFrame(frame);
      }
      observer.disconnect();
    };
  }, [branding.icon]);

  return (
    <>
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

      {/* Fallback FAB only if the top-bar injection couldn't find its anchor. */}
      {!injected && (
        <div className={styles.fabLayer}>
          <motion.button
            type="button"
            className={styles.fab}
            variants={fabVariants}
            initial={reduceMotion ? false : 'hidden'}
            animate="visible"
            whileHover="hover"
            whileTap="tap"
            onClick={() => setOpen((v) => !v)}
            aria-label="Open MCP Agent"
            data-testid="mcpagent-fab-button"
          >
            {isSafeIconSrc(branding.icon) ? (
              <img
                src={branding.icon}
                alt=""
                aria-hidden
                style={{ width: 24, height: 24, objectFit: 'contain', borderRadius: 6 }}
              />
            ) : (
              <Icon name="comment-alt-share" size="lg" />
            )}
          </motion.button>
        </div>
      )}
    </>
  );
}

/* Plain-DOM button styling (matches Grafana toolbar buttons) since this node is
 * created outside React and can't use useStyles2. */
const mcpTriggerClass = 'mcpagent-topbar-trigger-btn';
const triggerInnerHTML =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';

/* Escapes a string for safe interpolation into an HTML attribute value (the
 * top-bar button is built via innerHTML on a plain-DOM node). */
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/* Injected once: global style for the plain-DOM trigger button. */
if (typeof document !== 'undefined' && !document.getElementById('mcpagent-trigger-style')) {
  const style = document.createElement('style');
  style.id = 'mcpagent-trigger-style';
  style.textContent = `
    .${mcpTriggerClass} {
      display: inline-flex; align-items: center; justify-content: center;
      width: 32px; height: 32px; margin: 0 4px; padding: 0;
      border: none; border-radius: 8px; cursor: pointer;
      color: #fff; background: linear-gradient(135deg, #6c5ce7, #4834d4);
      box-shadow: 0 2px 8px rgba(72,52,212,0.35);
      transition: transform 120ms ease, box-shadow 120ms ease, filter 120ms ease;
    }
    .${mcpTriggerClass}:hover { transform: translateY(-1px); filter: brightness(1.08);
      box-shadow: 0 4px 14px rgba(72,52,212,0.45); }
    .${mcpTriggerClass}:active { transform: translateY(0) scale(0.96); }
  `;
  document.head.appendChild(style);
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
  fabLayer: css({
    position: 'fixed',
    right: theme.spacing(3),
    bottom: theme.spacing(3),
    zIndex: theme.zIndex.tooltip,
  }),
  fab: css({
    width: 56,
    height: 56,
    borderRadius: theme.shape.radius.circle,
    border: 'none',
    cursor: 'pointer',
    color: theme.colors.primary.contrastText,
    background: `linear-gradient(135deg, ${theme.colors.primary.main}, ${theme.colors.primary.shade})`,
    boxShadow: theme.shadows.z3,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  }),
});
