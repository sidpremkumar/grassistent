import { Transition, Variants } from 'framer-motion';

/**
 * Shared motion design tokens so every animated surface in the plugin feels
 * cohesive and "Apple-grade" from day one. Tuned for spring-based, physically
 * plausible motion rather than linear tweens.
 */

/** Primary spring used for entrances and layout shifts. */
export const spring: Transition = {
  type: 'spring',
  stiffness: 420,
  damping: 34,
  mass: 0.9,
};

/** Snappier spring for small interactive elements (chips, buttons). */
export const springFast: Transition = {
  type: 'spring',
  stiffness: 560,
  damping: 30,
  mass: 0.6,
};

/** Message bubbles rise and fade in, staggered by role via custom delay. */
export const messageVariants: Variants = {
  hidden: { opacity: 0, y: 14, scale: 0.98 },
  visible: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: spring,
  },
  exit: { opacity: 0, y: -8, scale: 0.98, transition: { duration: 0.15 } },
};

/** Tool chips pop in and can transition to a settled state. */
export const chipVariants: Variants = {
  hidden: { opacity: 0, scale: 0.8, y: 4 },
  visible: { opacity: 1, scale: 1, y: 0, transition: springFast },
  exit: { opacity: 0, scale: 0.8, transition: { duration: 0.12 } },
};

/** The page-context banner slides down from the header. */
export const contextVariants: Variants = {
  hidden: { opacity: 0, height: 0 },
  visible: { opacity: 1, height: 'auto', transition: spring },
  exit: { opacity: 0, height: 0, transition: { duration: 0.15 } },
};

/** Sidebar slides in from the right edge. */
export const sidebarVariants: Variants = {
  hidden: { opacity: 0, x: 24 },
  visible: { opacity: 1, x: 0, transition: spring },
};

/** Full page fades/rises on mount. */
export const pageVariants: Variants = {
  hidden: { opacity: 0, y: 12 },
  visible: { opacity: 1, y: 0, transition: spring },
};

/** Looping pulse for the "thinking" indicator. */
export const thinkingPulse: Variants = {
  animate: {
    opacity: [0.45, 1, 0.45],
    transition: { duration: 1.4, repeat: Infinity, ease: 'easeInOut' },
  },
};
