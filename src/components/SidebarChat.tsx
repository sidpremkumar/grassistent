import { css } from '@emotion/css';
import { motion, useReducedMotion } from 'framer-motion';
import { ChatPanel } from './ChatPanel';
import { sidebarVariants } from '../lib/motion';

/**
 * Sidebar extension entry. Grafana renders this inside the global
 * extension-sidebar slot, giving the "slide-out assistant" experience that
 * follows the user across pages and prefills from whatever they're viewing.
 */
export function SidebarChat() {
  const reduceMotion = useReducedMotion();
  return (
    <motion.div
      className={css({ height: '100%' })}
      variants={sidebarVariants}
      initial={reduceMotion ? false : 'hidden'}
      animate="visible"
    >
      <ChatPanel compact />
    </motion.div>
  );
}
