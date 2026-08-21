import { ReactNode, useMemo, useState } from 'react';
import { css } from '@emotion/css';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { GrafanaTheme2 } from '@grafana/data';
import { Icon, useStyles2 } from '@grafana/ui';

/**
 * JsonBlock renders one labeled, collapsible payload section (e.g. a tool
 * call's "Input" or "Output") with pretty-printed, syntax-highlighted JSON and
 * a one-click copy affordance. Non-JSON payloads gracefully fall back to plain
 * monospace text, so it is safe to hand it any tool result.
 */

type Props = {
  /** Section label rendered in the header, e.g. "Input" or "Output". */
  label: string;
  /** Raw payload: an object (tool input) or a string that may contain JSON. */
  value: unknown;
  /** Header accent, used to tint the label chip. */
  tone?: 'input' | 'output' | 'error';
  defaultOpen?: boolean;
};

/** Parses strings that contain JSON; passes objects through; null if not JSON. */
function toJsonValue(args: { value: unknown }): unknown | null {
  const { value } = args;
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'object') {
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
      return null;
    }
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return null;
    }
  }
  return null;
}

/** Matches one JSON token at a time so we can colorize without innerHTML. */
const JSON_TOKEN =
  /("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|(\btrue\b|\bfalse\b)|(\bnull\b)/g;

/** Tokenizes pretty-printed JSON into colorized spans (keys, strings, numbers…). */
function highlightJson(args: { text: string; styles: ReturnType<typeof getStyles> }): ReactNode[] {
  const { text, styles } = args;
  const nodes: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const match of text.matchAll(JSON_TOKEN)) {
    const index = match.index ?? 0;
    if (index > last) {
      nodes.push(text.slice(last, index));
    }
    const [full, str, colon, num, bool, nul] = match;
    if (str !== undefined) {
      nodes.push(
        <span key={key++} className={colon ? styles.tokenKey : styles.tokenString}>
          {str}
        </span>,
      );
      if (colon) {
        nodes.push(colon);
      }
    } else if (num !== undefined) {
      nodes.push(
        <span key={key++} className={styles.tokenNumber}>
          {num}
        </span>,
      );
    } else if (bool !== undefined) {
      nodes.push(
        <span key={key++} className={styles.tokenBool}>
          {bool}
        </span>,
      );
    } else if (nul !== undefined) {
      nodes.push(
        <span key={key++} className={styles.tokenNull}>
          {nul}
        </span>,
      );
    } else {
      nodes.push(full);
    }
    last = index + full.length;
  }
  if (last < text.length) {
    nodes.push(text.slice(last));
  }
  return nodes;
}

export function JsonBlock({ label, value, tone = 'input', defaultOpen = true }: Props) {
  const styles = useStyles2(getStyles);
  const reduceMotion = useReducedMotion();
  const [open, setOpen] = useState(defaultOpen);
  const [copied, setCopied] = useState(false);

  const { text, isJson } = useMemo(() => {
    const parsed = toJsonValue({ value });
    if (parsed !== null) {
      return { text: JSON.stringify(parsed, null, 2), isJson: true };
    }
    return { text: typeof value === 'string' ? value : String(value ?? ''), isJson: false };
  }, [value]);

  const body = useMemo(
    () => (isJson ? highlightJson({ text, styles }) : text),
    [isJson, text, styles],
  );

  if (!text.trim()) {
    return null;
  }

  const copy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable; ignore */
    }
  };

  return (
    <div className={styles.root} data-testid={`mcpagent-json-${label.toLowerCase()}`}>
      <div className={styles.headerRow}>
        <button
          type="button"
          className={styles.headerButton}
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          data-testid={`mcpagent-json-${label.toLowerCase()}-toggle`}
        >
          <motion.span
            className={styles.chevron}
            animate={{ rotate: open ? 90 : 0 }}
            transition={reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 500, damping: 30 }}
          >
            <Icon name="angle-right" size="xs" />
          </motion.span>
          <span
            className={css(
              styles.chip,
              tone === 'output' && styles.chipOutput,
              tone === 'error' && styles.chipError,
            )}
          >
            {label}
          </span>
          <span className={styles.meta}>{isJson ? 'json' : 'text'}</span>
        </button>
        <button
          type="button"
          className={styles.copyButton}
          onClick={copy}
          title="Copy to clipboard"
          data-testid={`mcpagent-json-${label.toLowerCase()}-copy`}
        >
          <Icon name={copied ? 'check' : 'copy'} size="xs" />
          <span>{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            className={styles.bodyWrap}
            initial={reduceMotion ? false : { height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 380, damping: 34 }}
          >
            <pre className={css(styles.pre, tone === 'error' && styles.preError)}>{body}</pre>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  root: css({
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
  }),
  headerRow: css({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing(1),
  }),
  headerButton: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(0.75),
    background: 'none',
    border: 'none',
    padding: theme.spacing(0.5, 0),
    cursor: 'pointer',
    color: theme.colors.text.secondary,
    minWidth: 0,
  }),
  chevron: css({
    display: 'inline-flex',
    color: theme.colors.text.disabled,
  }),
  chip: css({
    fontSize: '10px',
    fontWeight: theme.typography.fontWeightMedium,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    lineHeight: 1,
    padding: theme.spacing(0.5, 0.75),
    borderRadius: theme.shape.radius.pill,
    background: theme.colors.primary.transparent,
    color: theme.colors.primary.text,
  }),
  chipOutput: css({
    background: theme.colors.success.transparent,
    color: theme.colors.success.text,
  }),
  chipError: css({
    background: theme.colors.error.transparent,
    color: theme.colors.error.text,
  }),
  meta: css({
    fontSize: '10px',
    color: theme.colors.text.disabled,
    letterSpacing: '0.04em',
  }),
  copyButton: css({
    display: 'inline-flex',
    alignItems: 'center',
    gap: theme.spacing(0.5),
    background: 'none',
    border: 'none',
    padding: theme.spacing(0.25, 0.5),
    borderRadius: theme.shape.radius.default,
    cursor: 'pointer',
    color: theme.colors.text.disabled,
    fontSize: '10px',
    '&:hover': {
      color: theme.colors.text.primary,
      background: theme.colors.action.hover,
    },
  }),
  bodyWrap: css({ overflow: 'hidden' }),
  pre: css({
    margin: 0,
    padding: theme.spacing(1, 1.25),
    background: theme.colors.background.canvas,
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
    fontFamily: theme.typography.fontFamilyMonospace,
    fontSize: '11px',
    lineHeight: 1.6,
    color: theme.colors.text.primary,
    maxHeight: '260px',
    overflow: 'auto',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    tabSize: 2,
  }),
  preError: css({
    borderColor: theme.colors.error.border,
    color: theme.colors.error.text,
  }),
  tokenKey: css({ color: theme.visualization.getColorByName('blue') }),
  tokenString: css({ color: theme.visualization.getColorByName('green') }),
  tokenNumber: css({ color: theme.visualization.getColorByName('orange') }),
  tokenBool: css({ color: theme.visualization.getColorByName('purple') }),
  tokenNull: css({ color: theme.colors.text.disabled }),
});
