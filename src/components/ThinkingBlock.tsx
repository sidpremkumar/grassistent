import { useEffect, useMemo, useState } from 'react';
import { css, keyframes } from '@emotion/css';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { GrafanaTheme2 } from '@grafana/data';
import { Icon, useStyles2 } from '@grafana/ui';
import { ChatToolCall } from './use-agent-chat';
import { JsonBlock } from './JsonBlock';

/**
 * ThinkingBlock renders a Linear/Cursor-style collapsible "thinking" section:
 * a compact header that shimmers while the agent works, and an expandable body
 * that streams the model's reasoning and a live timeline of tool calls and
 * their results.
 *
 * While streaming it auto-expands; once the final answer arrives it collapses
 * to a quiet one-line summary the user can re-open.
 */

type Props = {
  reasoning: string;
  toolCalls: ChatToolCall[];
  streaming: boolean;
  /** True once visible answer content has begun streaming. */
  hasAnswer: boolean;
};

export function ThinkingBlock({ reasoning, toolCalls, streaming, hasAnswer }: Props) {
  const styles = useStyles2(getStyles);
  const reduceMotion = useReducedMotion();

  /* Auto-expand while thinking, auto-collapse once the answer starts. */
  const [manual, setManual] = useState<boolean | null>(null);
  const autoOpen = streaming && !hasAnswer;
  const open = manual ?? autoOpen;

  useEffect(() => {
    /* Reset manual override when a new turn begins streaming. */
    if (streaming && !hasAnswer) {
      setManual(null);
    }
  }, [streaming, hasAnswer]);

  const summary = useMemo(() => {
    const steps = toolCalls.length;
    if (streaming && !hasAnswer) {
      return 'Thinking';
    }
    if (steps === 0) {
      return 'Thought for a moment';
    }
    return `Worked through ${steps} step${steps === 1 ? '' : 's'}`;
  }, [streaming, hasAnswer, toolCalls.length]);

  const active = streaming && !hasAnswer;

  if (!reasoning && toolCalls.length === 0 && !active) {
    return null;
  }

  return (
    <div className={styles.root} data-testid="mcpagent-thinking">
      <button
        type="button"
        className={styles.header}
        onClick={() => setManual(!open)}
        aria-expanded={open}
        data-testid="mcpagent-thinking-toggle"
      >
        <motion.span
          className={styles.chevron}
          animate={{ rotate: open ? 90 : 0 }}
          transition={reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 500, damping: 30 }}
        >
          <Icon name="angle-right" size="sm" />
        </motion.span>
        <span className={active ? styles.shimmer : styles.summary}>{summary}</span>
        {active && <PulseDot />}
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            className={styles.bodyWrap}
            initial={reduceMotion ? false : { height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 380, damping: 34 }}
          >
            <div className={styles.body}>
              <div className={styles.rail} />
              <div className={styles.timeline}>
                {reasoning && <div className={styles.reasoning}>{reasoning}</div>}
                <AnimatePresence initial={false}>
                  {toolCalls.map((tc) => (
                    <ToolStep key={tc.id} tool={tc} styles={styles} reduceMotion={Boolean(reduceMotion)} />
                  ))}
                </AnimatePresence>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function ToolStep({
  tool,
  styles,
  reduceMotion,
}: {
  tool: ChatToolCall;
  styles: ReturnType<typeof getStyles>;
  reduceMotion: boolean;
}) {
  const [open, setOpen] = useState(false);
  const hasInput = tool.input !== undefined && tool.input !== null;
  const output = tool.output ?? tool.preview;
  const hasDetail = hasInput || Boolean(output) || Boolean(tool.error);
  const running = tool.status === 'running';

  return (
    <motion.div
      layout
      className={styles.step}
      initial={reduceMotion ? false : { opacity: 0, x: -6 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0 }}
      transition={reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 500, damping: 32 }}
    >
      <span className={css(styles.node, running && styles.nodeRunning, tool.status === 'error' && styles.nodeError)}>
        {running ? (
          <motion.span
            animate={{ rotate: 360 }}
            transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
            className={styles.nodeIcon}
          >
            <Icon name="sync" size="xs" />
          </motion.span>
        ) : tool.status === 'error' ? (
          <Icon name="exclamation-triangle" size="xs" />
        ) : (
          <Icon name="check" size="xs" />
        )}
      </span>

      <button
        type="button"
        className={styles.stepButton}
        onClick={() => hasDetail && setOpen((o) => !o)}
        disabled={!hasDetail}
        data-testid="mcpagent-thinking-step"
      >
        <span className={styles.stepName}>
          {tool.server && <span className={styles.stepServer}>{tool.server}</span>}
          {tool.name.replace(`${tool.server}__`, '')}
        </span>
        {hasDetail && (
          <motion.span animate={{ rotate: open ? 90 : 0 }} className={styles.stepChevron}>
            <Icon name="angle-right" size="xs" />
          </motion.span>
        )}
      </button>

      <AnimatePresence initial={false}>
        {open && hasDetail && (
          <motion.div
            className={styles.detailCard}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 380, damping: 34 }}
          >
            <div className={styles.detailInner}>
              {hasInput && <JsonBlock label="Input" value={tool.input} tone="input" />}
              {tool.error ? (
                <JsonBlock label="Error" value={tool.error} tone="error" />
              ) : (
                output && <JsonBlock label="Output" value={output} tone="output" />
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function PulseDot() {
  const styles = useStyles2(getStyles);
  return (
    <motion.span
      className={styles.pulse}
      animate={{ opacity: [0.4, 1, 0.4], scale: [0.9, 1, 0.9] }}
      transition={{ duration: 1.3, repeat: Infinity, ease: 'easeInOut' }}
    />
  );
}

const shimmerAnim = keyframes({
  '0%': { backgroundPosition: '100% 50%' },
  '100%': { backgroundPosition: '0% 50%' },
});

const getStyles = (theme: GrafanaTheme2) => ({
  root: css({
    marginBottom: theme.spacing(1),
  }),
  header: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(0.75),
    width: '100%',
    background: 'none',
    border: 'none',
    padding: theme.spacing(0.25, 0),
    cursor: 'pointer',
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
    textAlign: 'left',
  }),
  chevron: css({ display: 'inline-flex', color: theme.colors.text.disabled }),
  summary: css({ color: theme.colors.text.secondary }),
  shimmer: css({
    fontWeight: theme.typography.fontWeightMedium,
    background: `linear-gradient(90deg, ${theme.colors.text.disabled} 0%, ${theme.colors.text.primary} 20%, ${theme.colors.text.disabled} 40%)`,
    backgroundSize: '200% 100%',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    WebkitBackgroundClip: 'text',
    backgroundClip: 'text',
    color: 'transparent',
    animation: `${shimmerAnim} 1.8s linear infinite`,
  }),
  pulse: css({
    width: '6px',
    height: '6px',
    borderRadius: '50%',
    background: theme.colors.primary.main,
    display: 'inline-block',
  }),
  bodyWrap: css({ overflow: 'hidden' }),
  body: css({
    position: 'relative',
    display: 'flex',
    paddingTop: theme.spacing(0.75),
  }),
  rail: css({
    position: 'absolute',
    left: '7px',
    top: theme.spacing(1.5),
    bottom: theme.spacing(0.5),
    width: '1px',
    background: theme.colors.border.medium,
  }),
  timeline: css({
    display: 'flex',
    flexDirection: 'column',
    gap: theme.spacing(0.75),
    width: '100%',
  }),
  reasoning: css({
    marginLeft: theme.spacing(3),
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
    lineHeight: theme.typography.bodySmall.lineHeight,
    whiteSpace: 'pre-wrap',
  }),
  step: css({
    position: 'relative',
    paddingLeft: theme.spacing(3),
  }),
  node: css({
    position: 'absolute',
    left: 0,
    top: '1px',
    width: '15px',
    height: '15px',
    borderRadius: '50%',
    background: theme.colors.background.secondary,
    border: `1px solid ${theme.colors.border.medium}`,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: theme.colors.success.text,
    fontSize: '9px',
  }),
  nodeRunning: css({
    color: theme.colors.primary.text,
    borderColor: theme.colors.primary.border,
  }),
  nodeError: css({
    color: theme.colors.error.text,
    borderColor: theme.colors.error.border,
  }),
  nodeIcon: css({ display: 'inline-flex' }),
  stepButton: css({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    gap: theme.spacing(0.5),
    background: 'none',
    border: 'none',
    padding: 0,
    cursor: 'pointer',
    color: theme.colors.text.primary,
    fontSize: theme.typography.bodySmall.fontSize,
    textAlign: 'left',
    '&:disabled': { cursor: 'default' },
  }),
  stepName: css({
    fontFamily: theme.typography.fontFamilyMonospace,
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(0.75),
  }),
  stepServer: css({
    color: theme.colors.text.disabled,
    fontSize: '10px',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  }),
  stepChevron: css({ display: 'inline-flex', color: theme.colors.text.disabled }),
  detailCard: css({
    overflow: 'hidden',
  }),
  detailInner: css({
    display: 'flex',
    flexDirection: 'column',
    gap: theme.spacing(0.5),
    margin: theme.spacing(0.5, 0, 0.5, 0),
    padding: theme.spacing(0.75, 1),
    background: theme.colors.background.secondary,
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
  }),
});
