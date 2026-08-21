import { css, keyframes } from '@emotion/css';
import { motion, useReducedMotion } from 'framer-motion';
import { colorManipulator, GrafanaTheme2 } from '@grafana/data';
import { useStyles2, useTheme2 } from '@grafana/ui';
import { Branding, isSafeIconSrc } from '../lib/branding';
import { triggerVariants } from '../lib/motion';

/**
 * The single entry point to the agent: a compact icon button that lives in
 * Grafana's top nav toolbar (next to Search / New / Sign in).
 *
 * Design intent: it must look like the Grafana team shipped it. At rest it is
 * transparent like every native toolbar icon — the only tell is the glyph
 * itself, stroked with the theme's primary gradient. On hover/open the button
 * fills with that gradient (soft crossfade, spring scale), a one-shot specular
 * sheen sweeps across, and while a session is open a macOS-Dock-style dot sits
 * centered under the glyph. All color is derived from the active theme, so it
 * follows any operator theming, and everything honors reduced motion.
 *
 * It is rendered through a React portal into a host node we attach to the
 * toolbar, so unlike a hand-built DOM node it gets the full theme, Emotion
 * styling and framer-motion treatment used by the chat panel itself.
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
  const theme = useTheme2();
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
          <>
            {/* Two stacked copies crossfade: gradient-stroked at rest, solid
             * white once the gradient fill is behind it. */}
            <span className={styles.glyphTint}>
              <AgentGlyph gradientFrom={theme.colors.primary.main} gradientTo={theme.colors.primary.shade} />
            </span>
            <span className={styles.glyphSolid}>
              <AgentGlyph />
            </span>
          </>
        )}
      </span>
      {open && <span className={styles.dockDot} aria-hidden />}
    </motion.button>
  );
}

/**
 * Built-in glyph: a conversation bubble with an AI sparkle. When gradient stops
 * are provided the stroke/fill use them (rest state); otherwise `currentColor`.
 */
function AgentGlyph({ gradientFrom, gradientTo }: { gradientFrom?: string; gradientTo?: string }) {
  const gradient = gradientFrom !== undefined && gradientTo !== undefined;
  const paint = gradient ? 'url(#mcpagent-glyph-gradient)' : 'currentColor';
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke={paint}
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {gradient && (
        <defs>
          <linearGradient id="mcpagent-glyph-gradient" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor={gradientFrom} />
            <stop offset="1" stopColor={gradientTo} />
          </linearGradient>
        </defs>
      )}
      <path d="M20.5 11.9a8.5 8.5 0 0 1-12.4 7.6L3.5 20.9l1.2-4.4A8.5 8.5 0 1 1 20.5 11.9Z" />
      <path d="M12 7.8l.9 2.2 2.2.9-2.2.9-.9 2.2-.9-2.2-2.2-.9 2.2-.9.9-2.2Z" fill={paint} stroke="none" />
    </svg>
  );
}

/** One-shot specular highlight that sweeps across the button on hover. */
const sheen = keyframes({
  '0%': { transform: 'translateX(-140%) skewX(-16deg)', opacity: 0 },
  '40%': { opacity: 0.35 },
  '100%': { transform: 'translateX(140%) skewX(-16deg)', opacity: 0 },
});

/** Dock dot eases in once the panel is open. */
const dotIn = keyframes({
  from: { opacity: 0, transform: 'translateX(-50%) scale(0.4)' },
  to: { opacity: 1, transform: 'translateX(-50%) scale(1)' },
});

const getStyles = (theme: GrafanaTheme2) => {
  const { alpha } = colorManipulator;
  const from = theme.colors.primary.main;
  const to = theme.colors.primary.shade;
  /* The Apple-style crossfade curve: fast out, long settle. */
  const ease = 'cubic-bezier(0.22, 1, 0.36, 1)';

  return {
    trigger: css({
      position: 'relative',
      isolation: 'isolate',
      overflow: 'hidden',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      flex: '0 0 auto',
      width: 32,
      height: 32,
      margin: theme.spacing(0, 0.5),
      padding: 0,
      cursor: 'pointer',
      /* Native at rest: transparent and borderless, exactly like the New/Help
       * toolbar icons around it. */
      border: 'none',
      background: 'transparent',
      color: theme.colors.primary.contrastText,
      borderRadius: 7,
      transition: `box-shadow 240ms ${ease}`,
      /* Gradient fill, crossfaded in on hover/open so the idle state stays
       * indistinguishable from Grafana's own chrome. */
      '&::before': {
        content: '""',
        position: 'absolute',
        inset: 0,
        zIndex: -1,
        opacity: 0,
        background: `linear-gradient(135deg, ${from}, ${to})`,
        transition: `opacity 240ms ${ease}`,
      },
      /* Specular sweep; animated only while hovered. */
      '&::after': {
        content: '""',
        position: 'absolute',
        top: 0,
        bottom: 0,
        width: '40%',
        zIndex: -1,
        opacity: 0,
        background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.9), transparent)',
      },
      '&:hover::before': { opacity: 1 },
      '&:hover::after': { animation: `${sheen} 700ms ${ease}` },
      '&:hover': {
        boxShadow: `0 1px 3px ${alpha(from, 0.35)}, 0 4px 14px -4px ${alpha(from, 0.5)}`,
      },
      '&:focus-visible': {
        outline: 'none',
        boxShadow: `0 0 0 2px ${theme.colors.background.canvas}, 0 0 0 4px ${from}`,
      },
      '@media (prefers-reduced-motion: reduce)': {
        '&::after': { display: 'none' },
      },
      [theme.breakpoints.down('sm')]: { margin: 0 },
    }),
    triggerOpen: css({
      boxShadow: `0 1px 3px ${alpha(from, 0.35)}, 0 4px 14px -4px ${alpha(from, 0.5)}`,
      '&::before': { opacity: 1 },
    }),
    glyph: css({
      position: 'relative',
      zIndex: 1,
      display: 'inline-flex',
      width: 16,
      height: 16,
    }),
    /* Rest layer: primary-gradient stroke. Fades out as the fill fades in so
     * the stroke is never gradient-on-gradient. */
    glyphTint: css({
      position: 'absolute',
      inset: 0,
      display: 'inline-flex',
      opacity: 1,
      transition: `opacity 240ms ${ease}`,
      'button:hover &, button[aria-expanded="true"] &': { opacity: 0 },
    }),
    /* Active layer: solid contrast-white, visible over the gradient fill. */
    glyphSolid: css({
      position: 'absolute',
      inset: 0,
      display: 'inline-flex',
      opacity: 0,
      filter: 'drop-shadow(0 1px 1px rgba(0,0,0,0.2))',
      transition: `opacity 240ms ${ease}`,
      'button:hover &, button[aria-expanded="true"] &': { opacity: 1 },
    }),
    glyphImg: css({
      display: 'block',
      width: 18,
      height: 18,
      objectFit: 'contain',
      borderRadius: 4,
    }),
    /* macOS-Dock-style "running" indicator, centered under the glyph. */
    dockDot: css({
      position: 'absolute',
      bottom: 3,
      left: '50%',
      transform: 'translateX(-50%)',
      width: 3.5,
      height: 3.5,
      zIndex: 1,
      borderRadius: theme.shape.radius.circle,
      background: 'rgba(255, 255, 255, 0.95)',
      boxShadow: '0 0 4px rgba(255, 255, 255, 0.7)',
      animation: `${dotIn} 240ms ${ease} both`,
      '@media (prefers-reduced-motion: reduce)': { animation: 'none' },
    }),
  };
};
