import React, { useState } from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { Icon, useStyles2 } from '@grafana/ui';

/**
 * CopyButton is the shared "put this payload on the clipboard" affordance used
 * throughout the chat trace — a single tool input/output, or a whole turn dumped
 * as JSON for debugging.
 *
 * The payload is produced lazily: a turn dump serializes every tool result in
 * the message, which is wasted work on every render if the user never copies.
 */

type Props = {
  /** Produces the clipboard text. Called only on click. */
  getText: () => string;
  /** Visible label beside the icon. Omit for an icon-only control. */
  label?: string;
  /** Label swapped in for ~1.2s after a successful copy. */
  copiedLabel?: string;
  title?: string;
  testId?: string;
};

/**
 * Writes to the clipboard, falling back to a hidden textarea + execCommand.
 * The async Clipboard API is unavailable on plain-HTTP Grafana installs, which
 * is exactly where a self-hosted plugin tends to be debugged.
 */
async function writeClipboard(args: { text: string }): Promise<boolean> {
  const { text } = args;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

export function CopyButton({ getText, label, copiedLabel = 'Copied', title, testId }: Props) {
  const styles = useStyles2(getStyles);
  const [copied, setCopied] = useState(false);

  const onClick = (e: React.MouseEvent) => {
    /* These buttons live inside clickable headers; a copy must never also
     * collapse the section it belongs to. */
    e.stopPropagation();
    e.preventDefault();
    void writeClipboard({ text: getText() }).then((ok) => {
      if (!ok) {
        return;
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };

  return (
    <button
      type="button"
      className={styles.button}
      onClick={onClick}
      title={title ?? (label ? `${label} to clipboard` : 'Copy to clipboard')}
      aria-label={title ?? label ?? 'Copy to clipboard'}
      data-testid={testId}
    >
      <Icon name={copied ? 'check' : 'copy'} size="xs" />
      {label && <span>{copied ? copiedLabel : label}</span>}
    </button>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  button: css({
    display: 'inline-flex',
    alignItems: 'center',
    gap: theme.spacing(0.5),
    flexShrink: 0,
    background: 'none',
    border: 'none',
    padding: theme.spacing(0.25, 0.5),
    borderRadius: theme.shape.radius.default,
    cursor: 'pointer',
    color: theme.colors.text.disabled,
    fontSize: '10px',
    lineHeight: 1.4,
    whiteSpace: 'nowrap',
    transition: 'color 120ms ease, background 120ms ease',
    '&:hover': {
      color: theme.colors.text.primary,
      background: theme.colors.action.hover,
    },
  }),
});
