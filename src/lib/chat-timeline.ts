/**
 * Chronological trace of one assistant turn.
 *
 * The streamed events carry order implicitly, but the message model used to
 * throw it away: every `content` delta was concatenated into one `content`
 * string and every tool call pushed onto a separate array. Rendering those two
 * fields could only ever produce "all tool calls, then all prose", so a turn
 * that actually went prose -> tool -> prose -> tool displayed with its steps
 * bunched at the top and its narration merged into the final answer.
 *
 * This module keeps an append-only list of entries in the order they arrived.
 * `content` is still maintained alongside it, because the backend transcript,
 * the chat title, and "copy answer" all want the flat text.
 */

export type ChatTimelineEntry =
  /** A run of streamed answer prose. */
  | { kind: 'text'; id: string; text: string }
  /** A run of streamed model reasoning. */
  | { kind: 'reasoning'; id: string; text: string }
  /** A tool call, identified by its toolUse id; the call itself lives in `toolCalls`. */
  | { kind: 'tool'; id: string };

/**
 * Entries are only ever appended, so the current length is a stable unique key
 * for a new one — no counter to thread through, and ids stay consistent across
 * re-renders and persistence.
 */
function entryId(args: { kind: string; timeline: ChatTimelineEntry[] }): string {
  return `${args.kind}-${args.timeline.length}`;
}

/**
 * Appends a streamed text/reasoning delta, merging into the trailing entry when
 * it is the same kind. Without the merge every token would become its own
 * entry, which is both slow and impossible to render as flowing prose.
 */
export function appendStreamedText(args: {
  timeline: ChatTimelineEntry[];
  kind: 'text' | 'reasoning';
  text: string;
}): ChatTimelineEntry[] {
  const { timeline, kind, text } = args;
  const last = timeline[timeline.length - 1];
  if (last && last.kind === kind) {
    const merged: ChatTimelineEntry = { kind, id: last.id, text: last.text + text };
    return [...timeline.slice(0, -1), merged];
  }
  return [...timeline, { kind, id: entryId({ kind, timeline }), text }];
}

/** Appends a tool call at its real position in the turn. */
export function appendToolEntry(args: {
  timeline: ChatTimelineEntry[];
  toolCallId: string;
}): ChatTimelineEntry[] {
  return [...args.timeline, { kind: 'tool', id: args.toolCallId }];
}

/**
 * Replaces the trailing prose entry, for a terminal event that carries a
 * whole-answer payload rather than a delta. Appending in that case would render
 * the answer twice.
 */
export function replaceTrailingText(args: {
  timeline: ChatTimelineEntry[];
  text: string;
}): ChatTimelineEntry[] {
  const { timeline, text } = args;
  const last = timeline[timeline.length - 1];
  if (last && last.kind === 'text') {
    return [...timeline.slice(0, -1), { kind: 'text', id: last.id, text }];
  }
  return [...timeline, { kind: 'text', id: entryId({ kind: 'text', timeline }), text }];
}

/**
 * Splits a turn into the trace and the final answer.
 *
 * The answer is the LAST text entry and only when the turn ends on prose: text
 * that precedes a tool call is narration ("let me check the label values
 * first"), which belongs in the trace at the point it was said, not glued onto
 * the front of the answer. A turn that ends on a tool call has no answer.
 */
export function splitTimeline(args: { timeline: ChatTimelineEntry[] }): {
  trace: ChatTimelineEntry[];
  answer: string;
} {
  const { timeline } = args;
  const last = timeline[timeline.length - 1];
  if (last && last.kind === 'text') {
    return { trace: timeline.slice(0, -1), answer: last.text };
  }
  return { trace: timeline, answer: '' };
}

/**
 * Builds a timeline for a message persisted before timelines existed, so old
 * conversations still render. The original order is unrecoverable, so this
 * reproduces exactly what the old UI showed: reasoning, then every tool call,
 * then the answer.
 */
export function legacyTimeline(args: {
  reasoning: string;
  content: string;
  toolCallIds: string[];
}): ChatTimelineEntry[] {
  const { reasoning, content, toolCallIds } = args;
  const timeline: ChatTimelineEntry[] = [];
  if (reasoning) {
    timeline.push({ kind: 'reasoning', id: 'reasoning-legacy', text: reasoning });
  }
  for (const id of toolCallIds) {
    timeline.push({ kind: 'tool', id });
  }
  if (content) {
    timeline.push({ kind: 'text', id: 'text-legacy', text: content });
  }
  return timeline;
}
