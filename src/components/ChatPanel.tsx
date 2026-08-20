import React, { useEffect, useMemo, useRef, useState } from 'react';
import { css } from '@emotion/css';
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from 'framer-motion';
import { GrafanaTheme2 } from '@grafana/data';
import { Button, Icon, TextArea, useStyles2 } from '@grafana/ui';
import { useAgentChat, ChatMessage, ChatToolCall } from './use-agent-chat';
import { buildPrefill, extractPageContext } from '../lib/page-context';
import { PageContext } from '../lib/protocol';
import { chipVariants, contextVariants, messageVariants, thinkingPulse } from '../lib/motion';

/**
 * ChatPanel is the reusable chat surface, rendered both on the full-page app
 * route and inside the slide-out sidebar extension. It reads the current
 * Grafana page context on mount and prefills the input with a suggested
 * question, which the user can edit or clear before sending.
 *
 * All motion is driven by framer-motion and respects the user's reduced-motion
 * preference (falls back to instant transitions).
 */

type Props = {
  /** Distinguishes the sidebar (compact) layout from the full page. */
  compact?: boolean;
};

const genSessionId = (): string => `sess-${Math.random().toString(36).slice(2)}-${Date.now()}`;

export function ChatPanel({ compact = false }: Props) {
  const styles = useStyles2(getStyles);
  const sessionId = useMemo(genSessionId, []);
  const { messages, busy, send, cancel, reset } = useAgentChat(sessionId);
  const reduceMotion = useReducedMotion();

  const [input, setInput] = useState('');
  const [pageContext, setPageContext] = useState<PageContext>({});
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ctx = extractPageContext();
    setPageContext(ctx);
    setInput(buildPrefill(ctx));
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  const onSend = () => {
    const text = input.trim();
    if (!text) {
      return;
    }
    void send(text, pageContext);
    setInput('');
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  };

  /* When reduced motion is requested, collapse variants to no-op transitions. */
  const initial = reduceMotion ? false : 'hidden';

  return (
    <div className={css(styles.root, compact && styles.rootCompact)} data-testid="mcpagent-chat">
      <div className={styles.header}>
        <div className={styles.title}>
          <Icon name="comment-alt-share" /> MCP Agent
        </div>
        <Button
          size="sm"
          variant="secondary"
          fill="text"
          icon="trash-alt"
          onClick={reset}
          data-testid="mcpagent-reset"
          tooltip="New conversation"
        />
      </div>

      <AnimatePresence initial={false}>
        {pageContext.summary && (
          <motion.div
            className={styles.context}
            data-testid="mcpagent-context"
            variants={contextVariants}
            initial={initial}
            animate="visible"
            exit="exit"
          >
            <Icon name="compass" size="sm" /> {pageContext.summary}
          </motion.div>
        )}
      </AnimatePresence>

      <div className={styles.messages} ref={scrollRef} data-testid="mcpagent-messages">
        {messages.length === 0 && (
          <motion.div
            className={styles.empty}
            initial={initial}
            animate="visible"
            variants={messageVariants}
          >
            Ask a question about what you&apos;re viewing. The agent can call your configured MCP tools to
            investigate.
          </motion.div>
        )}
        <LayoutGroup>
          <AnimatePresence initial={false}>
            {messages.map((m) => (
              <MessageBubble key={m.id} message={m} styles={styles} initial={initial} />
            ))}
          </AnimatePresence>
        </LayoutGroup>
      </div>

      <div className={styles.inputRow}>
        <TextArea
          value={input}
          onChange={(e) => setInput(e.currentTarget.value)}
          onKeyDown={onKeyDown}
          placeholder="Ask anything about this page\u2026"
          rows={compact ? 2 : 3}
          data-testid="mcpagent-input"
        />
        <AnimatePresence mode="wait" initial={false}>
          {busy ? (
            <motion.div
              key="stop"
              initial={reduceMotion ? false : { opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
            >
              <Button variant="destructive" icon="square-shape" onClick={cancel} data-testid="mcpagent-stop">
                Stop
              </Button>
            </motion.div>
          ) : (
            <motion.div
              key="send"
              initial={reduceMotion ? false : { opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              whileTap={reduceMotion ? undefined : { scale: 0.94 }}
            >
              <Button icon="message" onClick={onSend} disabled={!input.trim()} data-testid="mcpagent-send">
                Send
              </Button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

function MessageBubble({
  message,
  styles,
  initial,
}: {
  message: ChatMessage;
  styles: ReturnType<typeof getStyles>;
  initial: 'hidden' | false;
}) {
  const isUser = message.role === 'user';
  return (
    <motion.div
      layout
      className={css(styles.bubbleWrap, isUser ? styles.bubbleWrapUser : styles.bubbleWrapAssistant)}
      variants={messageVariants}
      initial={initial}
      animate="visible"
      exit="exit"
    >
      <div className={css(styles.bubble, isUser ? styles.bubbleUser : styles.bubbleAssistant)}>
        {message.toolCalls.length > 0 && (
          <div className={styles.toolTrace}>
            <AnimatePresence initial={false}>
              {message.toolCalls.map((tc) => (
                <ToolChip key={tc.id} tool={tc} styles={styles} initial={initial} />
              ))}
            </AnimatePresence>
          </div>
        )}
        {message.content && <div className={styles.content}>{message.content}</div>}
        <AnimatePresence>
          {message.streaming && (
            <motion.div
              className={styles.streaming}
              variants={thinkingPulse}
              animate="animate"
              exit={{ opacity: 0 }}
            >
              <ThinkingDots />
              {message.status ?? 'Thinking\u2026'}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}

/** Three-dot loader with a staggered vertical bounce. */
function ThinkingDots() {
  const styles = useStyles2(getStyles);
  return (
    <span className={styles.dots} aria-hidden>
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className={styles.dot}
          animate={{ y: [0, -3, 0] }}
          transition={{ duration: 0.9, repeat: Infinity, ease: 'easeInOut', delay: i * 0.15 }}
        />
      ))}
    </span>
  );
}

function ToolChip({
  tool,
  styles,
  initial,
}: {
  tool: ChatToolCall;
  styles: ReturnType<typeof getStyles>;
  initial: 'hidden' | false;
}) {
  const isRunning = tool.status === 'running';
  const icon = isRunning ? 'sync' : tool.status === 'error' ? 'exclamation-triangle' : 'check';
  return (
    <motion.div
      layout
      className={css(styles.toolChip, tool.status === 'error' && styles.toolChipError)}
      title={tool.error ?? tool.preview ?? ''}
      data-testid="mcpagent-toolchip"
      variants={chipVariants}
      initial={initial}
      animate="visible"
      exit="exit"
    >
      <motion.span
        animate={isRunning ? { rotate: 360 } : { rotate: 0 }}
        transition={isRunning ? { duration: 1, repeat: Infinity, ease: 'linear' } : { duration: 0.2 }}
        className={styles.toolIcon}
      >
        <Icon name={icon} size="sm" />
      </motion.span>
      <span className={styles.toolName}>
        {tool.server ? `${tool.server} / ` : ''}
        {tool.name}
      </span>
    </motion.div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  root: css({
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: 0,
    background: theme.colors.background.primary,
  }),
  rootCompact: css({
    maxWidth: '420px',
  }),
  header: css({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: theme.spacing(1, 2),
    borderBottom: `1px solid ${theme.colors.border.weak}`,
  }),
  title: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
    fontWeight: theme.typography.fontWeightMedium,
  }),
  context: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
    padding: theme.spacing(1, 2),
    fontSize: theme.typography.bodySmall.fontSize,
    color: theme.colors.text.secondary,
    background: theme.colors.background.secondary,
    borderBottom: `1px solid ${theme.colors.border.weak}`,
    overflow: 'hidden',
  }),
  messages: css({
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    padding: theme.spacing(2),
    display: 'flex',
    flexDirection: 'column',
    gap: theme.spacing(1.5),
  }),
  empty: css({
    color: theme.colors.text.secondary,
    textAlign: 'center',
    margin: 'auto',
    maxWidth: '32ch',
  }),
  bubbleWrap: css({ display: 'flex' }),
  bubbleWrapUser: css({ justifyContent: 'flex-end' }),
  bubbleWrapAssistant: css({ justifyContent: 'flex-start' }),
  bubble: css({
    maxWidth: '85%',
    padding: theme.spacing(1, 1.5),
    borderRadius: theme.shape.radius.default,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    boxShadow: theme.shadows.z1,
  }),
  bubbleUser: css({
    background: theme.colors.primary.main,
    color: theme.colors.primary.contrastText,
  }),
  bubbleAssistant: css({
    background: theme.colors.background.secondary,
    border: `1px solid ${theme.colors.border.weak}`,
  }),
  content: css({ lineHeight: theme.typography.body.lineHeight }),
  toolTrace: css({
    display: 'flex',
    flexWrap: 'wrap',
    gap: theme.spacing(0.5),
    marginBottom: theme.spacing(1),
  }),
  toolChip: css({
    display: 'inline-flex',
    alignItems: 'center',
    gap: theme.spacing(0.5),
    padding: theme.spacing(0.25, 0.75),
    borderRadius: theme.shape.radius.pill,
    background: theme.colors.background.canvas,
    border: `1px solid ${theme.colors.border.medium}`,
    fontSize: theme.typography.bodySmall.fontSize,
    color: theme.colors.text.secondary,
  }),
  toolChipError: css({
    borderColor: theme.colors.error.border,
    color: theme.colors.error.text,
  }),
  toolIcon: css({ display: 'inline-flex' }),
  toolName: css({ fontFamily: theme.typography.fontFamilyMonospace }),
  streaming: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
    marginTop: theme.spacing(1),
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  dots: css({ display: 'inline-flex', gap: '3px', alignItems: 'flex-end' }),
  dot: css({
    width: '5px',
    height: '5px',
    borderRadius: '50%',
    background: 'currentColor',
    display: 'inline-block',
  }),
  inputRow: css({
    display: 'flex',
    gap: theme.spacing(1),
    padding: theme.spacing(2),
    borderTop: `1px solid ${theme.colors.border.weak}`,
    alignItems: 'flex-end',
  }),
});
