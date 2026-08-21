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

/** Full page fades/rises on mount. */
export const pageVariants: Variants = {
  hidden: { opacity: 0, y: 12 },
  visible: { opacity: 1, y: 0, transition: spring },
};

/** Right-side drawer slides in from the edge. */
export const drawerVariants: Variants = {
  hidden: { x: '100%' },
  visible: { x: 0, transition: spring },
  exit: { x: '100%', transition: { duration: 0.2, ease: 'easeInOut' } },
};

/** Backdrop fade behind the drawer. */
export const backdropVariants: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { duration: 0.2 } },
  exit: { opacity: 0, transition: { duration: 0.15 } },
};

/** Top-bar trigger icon: settles in, with a lift on hover and a press response. */
export const triggerVariants: Variants = {
  hidden: { opacity: 0, scale: 0.7 },
  visible: { opacity: 1, scale: 1, y: 0, transition: spring },
  hover: { y: -1, scale: 1.06, transition: springFast },
  tap: { y: 0, scale: 0.92, transition: springFast },
};

/** Chat popover rises from the button anchor (bottom-right origin). */
export const popoverVariants: Variants = {
  hidden: { opacity: 0, scale: 0.96, y: 16 },
  visible: { opacity: 1, scale: 1, y: 0, transition: spring },
  exit: { opacity: 0, scale: 0.96, y: 16, transition: { duration: 0.16 } },
};

/** Looping pulse for the "thinking" indicator. */
export const thinkingPulse: Variants = {
  animate: {
    opacity: [0.45, 1, 0.45],
    transition: { duration: 1.4, repeat: Infinity, ease: 'easeInOut' },
  },
};
