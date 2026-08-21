import { css, keyframes } from '@emotion/css';
import { motion, useReducedMotion } from 'framer-motion';
import { GrafanaTheme2 } from '@grafana/data';
import { useStyles2 } from '@grafana/ui';
import { Branding, isSafeIconSrc } from '../lib/branding';
import { triggerVariants } from '../lib/motion';

/**
 * The single entry point to the agent: a compact, high-tech icon button that
 * lives in Grafana's top nav toolbar (next to Search / New / Sign in).
 *
 * It is rendered through a React portal into a host node we attach to the
 * toolbar, so unlike a hand-built DOM node it gets the full theme, Emotion
 * styling and framer-motion treatment used by the chat panel itself:
 *  - glass base that lifts into the panel's primary gradient on hover/open,
 *  - a one-shot light sheen sweep on hover,
 *  - a persistent glow plus "live" dot while the panel is open.
 */

type Props = {
  /** Whether the chat panel is currently open (drives the active styling). */
  open: boolean;
  /** Operator branding; a safe custom icon replaces the built-in glyph. */
  branding: Branding;
  /** Human-readable keyboard shortcut shown in the tooltip, e.g. "⌘⇧A". */
  shortcut: string;
  onToggle: () => void;
};

export function TopBarTrigger({ open, branding, shortcut, onToggle }: Props) {
  const styles = useStyles2(getStyles);
  const reduceMotion = useReducedMotion();
  const name = branding.name?.trim() || 'MCP Agent';
  const customIcon = isSafeIconSrc(branding.icon) ? branding.icon : undefined;

  return (
    <motion.button
      type="button"
      id="mcpagent-topbar-trigger"
      className={`${styles.trigger} ${open ? styles.triggerOpen : ''}`}
      variants={triggerVariants}
      initial={reduceMotion ? false : 'hidden'}
      animate="visible"
      whileHover={reduceMotion ? undefined : 'hover'}
      whileTap={reduceMotion ? undefined : 'tap'}
      onClick={onToggle}
      aria-label={`${open ? 'Close' : 'Open'} ${name}`}
      aria-expanded={open}
      title={`${name} · ${shortcut}`}
      data-testid="mcpagent-topbar-trigger"
    >
      <span className={styles.glyph}>
        {customIcon ? (
          <img src={customIcon} alt="" aria-hidden className={styles.glyphImg} />
        ) : (
          <AgentGlyph />
        )}
      </span>
      {open && <span className={styles.live} aria-hidden />}
    </motion.button>
  );
}

/** Built-in glyph: a conversation bubble with an AI sparkle. */
function AgentGlyph() {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M20.5 11.9a8.5 8.5 0 0 1-12.4 7.6L3.5 20.9l1.2-4.4A8.5 8.5 0 1 1 20.5 11.9Z" />
      <path d="M12 7.6l1 2.4 2.4 1-2.4 1-1 2.4-1-2.4-2.4-1 2.4-1 1-2.4Z" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** One-shot specular highlight that sweeps across the button on hover. */
const sheen = keyframes({
  '0%': { transform: 'translateX(-130%) skewX(-18deg)', opacity: 0 },
  '35%': { opacity: 0.55 },
  '100%': { transform: 'translateX(130%) skewX(-18deg)', opacity: 0 },
});

/** Soft breathing halo while a chat session is open. */
const halo = keyframes({
  '0%, 100%': { opacity: 0.35 },
  '50%': { opacity: 0.75 },
});

const getStyles = (theme: GrafanaTheme2) => {
  const from = theme.colors.primary.main;
  const to = theme.colors.primary.shade;
  const glow = theme.isDark ? 'rgba(110, 90, 255, 0.45)' : 'rgba(60, 90, 220, 0.3)';

  return {
    trigger: css({
      position: 'relative',
      isolation: 'isolate',
      overflow: 'hidden',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      flex: '0 0 auto',
      width: 34,
      height: 32,
      margin: theme.spacing(0, 0.5),
      padding: 0,
      cursor: 'pointer',
      color: theme.colors.text.primary,
      borderRadius: 9,
      border: `1px solid ${theme.colors.border.weak}`,
      background: theme.isDark ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0, 0, 0, 0.035)',
      transition: 'color 160ms ease, border-color 160ms ease, box-shadow 200ms ease',
      /* Gradient fill, faded in on hover/open so the idle state stays quiet in
       * the middle of Grafana's chrome. */
      '&::before': {
        content: '""',
        position: 'absolute',
        inset: 0,
        zIndex: -1,
        opacity: 0,
        background: `linear-gradient(140deg, ${from}, ${to})`,
        transition: 'opacity 200ms ease',
      },
      /* Specular sweep; animated only while hovered. */
      '&::after': {
        content: '""',
        position: 'absolute',
        top: 0,
        bottom: 0,
        width: '45%',
        zIndex: -1,
        opacity: 0,
        background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.85), transparent)',
      },
      '&:hover': {
        color: theme.colors.primary.contrastText,
        borderColor: 'transparent',
        boxShadow: `0 6px 18px -6px ${glow}, 0 0 0 1px ${glow}`,
      },
      '&:hover::before': { opacity: 1 },
      '&:hover::after': { animation: `${sheen} 850ms ease` },
      '&:focus-visible': {
        outline: 'none',
        boxShadow: `0 0 0 2px ${theme.colors.background.canvas}, 0 0 0 4px ${from}`,
      },
      [theme.breakpoints.down('sm')]: { margin: 0 },
    }),
    triggerOpen: css({
      color: theme.colors.primary.contrastText,
      borderColor: 'transparent',
      boxShadow: `0 6px 18px -6px ${glow}, 0 0 0 1px ${glow}`,
      '&::before': { opacity: 1 },
    }),
    glyph: css({
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      /* Lifts the glyph above the gradient/sheen pseudo-elements. */
      position: 'relative',
      zIndex: 1,
      filter: 'drop-shadow(0 1px 1px rgba(0,0,0,0.25))',
    }),
    glyphImg: css({
      display: 'block',
      width: 18,
      height: 18,
      objectFit: 'contain',
      borderRadius: 4,
    }),
    live: css({
      position: 'absolute',
      top: 3,
      right: 3,
      width: 5,
      height: 5,
      zIndex: 1,
      borderRadius: theme.shape.radius.circle,
      background: theme.colors.success.main,
      boxShadow: `0 0 0 2px ${theme.colors.primary.main}`,
      animation: `${halo} 2.4s ease-in-out infinite`,
      '@media (prefers-reduced-motion: reduce)': { animation: 'none' },
    }),
  };
};
