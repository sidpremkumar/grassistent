import { css } from '@emotion/css';
import { motion, useReducedMotion } from 'framer-motion';
import { GrafanaTheme2 } from '@grafana/data';
import { useStyles2 } from '@grafana/ui';
import { ChatPanel } from '../components/ChatPanel';
import { pageVariants } from '../lib/motion';

/**
 * Full-page app route (nav item "Chat"). Renders the chat panel centered in a
 * comfortable reading column with a subtle mount animation.
 */
export function AppPage() {
  const styles = useStyles2(getStyles);
  const reduceMotion = useReducedMotion();
  return (
    <div className={styles.page} data-testid="mcpagent-app-page">
      <motion.div
        className={styles.column}
        variants={pageVariants}
        initial={reduceMotion ? false : 'hidden'}
        animate="visible"
      >
        <ChatPanel />
      </motion.div>
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  page: css({
    display: 'flex',
    justifyContent: 'center',
    height: '100%',
    minHeight: 0,
  }),
  column: css({
    width: '100%',
    maxWidth: '900px',
    height: '100%',
    minHeight: 0,
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
    overflow: 'hidden',
  }),
});
