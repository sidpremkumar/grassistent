import { ChatMessage, ChatToolCall } from '../components/use-agent-chat';
import { PageContext } from './protocol';

/**
 * Debug dumps for a chat turn.
 *
 * When the agent misbehaves — calls a tool that does not exist, passes the wrong
 * argument shape, or claims a page change that never happened — the evidence is
 * spread across the streamed answer, the reasoning, and each tool call's
 * input/output. These builders serialize all of it into one JSON blob the user
 * can paste into a bug report or another agent, instead of expanding every step
 * and copying it piecemeal.
 *
 * Tool outputs are strings on the wire but usually contain JSON, so they are
 * re-parsed where possible: a dump full of escaped `"{\"foo\":1}"` is far harder
 * to read than nested objects.
 */

/** Re-parses a JSON-looking string so the dump nests instead of escaping. */
function reviveJson(args: { value: string | undefined }): unknown {
  const { value } = args;
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return value;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

type ToolCallDump = {
  id: string;
  server: string;
  name: string;
  status: ChatToolCall['status'];
  input?: unknown;
  output?: unknown;
  preview?: string;
  error?: string;
};

function toolCallDump(args: { tool: ChatToolCall }): ToolCallDump {
  const { tool } = args;
  return {
    id: tool.id,
    server: tool.server,
    name: tool.name,
    status: tool.status,
    input: tool.input,
    output: reviveJson({ value: tool.output }),
    /* Only worth carrying when it is not just a prefix of the full output. */
    preview: tool.output ? undefined : tool.preview,
    error: tool.error,
  };
}

/** One tool call as pretty-printed JSON, for copying a single failing step. */
export function toolCallDumpJson(args: { tool: ChatToolCall }): string {
  return JSON.stringify(toolCallDump(args), null, 2);
}

/**
 * The whole assistant turn as pretty-printed JSON: what the model said, what it
 * was thinking, every tool call with its arguments and result, and the page
 * context the frontend had at the time.
 */
export function turnDumpJson(args: { message: ChatMessage; pageContext?: PageContext }): string {
  const { message, pageContext } = args;
  return JSON.stringify(
    {
      capturedAt: new Date().toISOString(),
      role: message.role,
      streaming: message.streaming,
      answer: message.content,
      reasoning: message.reasoning || undefined,
      toolCalls: message.toolCalls.map((tool) => toolCallDump({ tool })),
      failedToolCalls: message.toolCalls.filter((tc) => tc.status === 'error').map((tc) => tc.name),
      pageContext,
    },
    null,
    2,
  );
}
