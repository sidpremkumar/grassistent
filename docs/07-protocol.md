# 07 — Protocol (wire contracts)

Defined in `src/lib/protocol.ts` (frontend) and mirrored by `pkg/agent/Event` + `pkg/plugin/resources.chatRequest` (backend). Keep both sides in sync.

## Frontend → Backend: `ChatRequest`

`POST /api/plugins/mcpagent-app/resources/chat`, `Content-Type: application/json`, `Accept: text/event-stream`.

```ts
type ChatRequest = {
  sessionId: string;
  message: string;                 // ignored when continuation is set
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  pageContext?: PageContext;       // see 06-page-context.md
  browserTools?: BrowserToolSpec[];        // tools the frontend can run in the page (see 11-browser-tools.md)
  continuation?: string;                   // opaque resume token from a `paused` event
  toolResults?: BrowserToolResult[];       // results of the browser tool calls the paused turn requested
};

type BrowserToolSpec = { name: string; description: string; inputSchema: Record<string, unknown> };
type BrowserToolResult = { id: string; content: string; isError?: boolean };
```

Backend struct (`resources.go`):
```go
type chatRequest struct {
  SessionID    string                    `json:"sessionId"`
  Message      string                    `json:"message"`
  History      []agent.Turn              `json:"history"`
  PageContext  *pageContext              `json:"pageContext"`
  BrowserTools []agent.BrowserToolSpec   `json:"browserTools"`
  Continuation string                    `json:"continuation"`
  ToolResults  []agent.BrowserToolResult `json:"toolResults"`
}
```

- `sessionId` is currently informational (no server-side session store). Multi-turn context comes from client-supplied `history`.
- Empty `message` **and** empty `continuation` → HTTP 400.
- When `continuation` is set the request resumes a paused turn: `message`/`history` are ignored, `toolResults` answer the pending `browser_tool_call`s, and `pageContext` is injected as post-action observation.

## Backend → Frontend: SSE stream of `AgentEvent`

Each frame: `data: <json>\n\n`. Parsed by `chat-stream.ts` (split on `\n\n`, take the `data:` line, `parseAgentEvent`).

```ts
type AgentEvent =
  | { type: 'content';   text: string }
  | { type: 'reasoning'; text: string }                                    // defined, not emitted yet
  | { type: 'tool_call'; id: string; server: string; name: string; input: unknown; status: 'running' }
  | { type: 'tool_result'; id: string; status: 'completed' | 'error'; preview?: string; error?: string }
  | { type: 'browser_tool_call'; id: string; server: 'browser'; name: string; input: unknown; status: 'running' }
  | { type: 'paused'; continuation: string }                               // terminal-for-this-stream; resume via continuation POST
  | { type: 'status';  text: string }                                      // defined, not emitted yet
  | { type: 'done';    content?: string }                                  // text already streamed; content optional
  | { type: 'error';   error: string };
```

### Event semantics
- `content` — a chunk of the visible answer, streamed **token-by-token** as `ConverseStream` text deltas arrive (typewriter effect).
- `tool_call` — the model requested a tool; `id` correlates with the later `tool_result`. `name` is namespaced `<server>__<tool>`.
- `tool_result` — tool finished; `completed` carries a truncated `preview`, `error` carries `error` text.
- `browser_tool_call` — the model wants the **frontend** to execute a tool in the page (`name` is un-namespaced). No `tool_result` follows on the wire: the frontend executes locally and reports via the continuation POST.
- `paused` — the stream is ending because browser tools are pending; `continuation` must be echoed back with `toolResults` to resume the turn. See [11-browser-tools.md](./11-browser-tools.md).
- `done` — terminal success. `content` is **optional and usually omitted**: the answer was already streamed via `content` deltas, so the client keeps what it has. Always the last event on success.
- `error` — terminal failure; loop stops. Frontend renders the error and ends streaming.

### Guarantees
- Exactly one terminal event (`done`, `error`, or `paused`) per stream under normal operation. A logical *turn* may span several streams chained by continuations.
- `chat-stream.ts` also calls `onDone`/`onError` on stream end/abort so the UI never hangs even if a terminal event is missing.

## Backend → Frontend mapping

`pkg/agent/Event` is emitted with `json` tags matching the `AgentEvent` fields. Note the Go struct is a single flat type with `omitempty`; only the relevant fields are populated per event type. The frontend discriminates on `type`.

## Versioning

No explicit protocol version field yet. If you evolve `AgentEvent`, prefer additive fields and keep the `type` discriminant stable; the frontend's `default:` case ignores unknown event types.
