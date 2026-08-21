# 05 — Agent loop

`pkg/agent/agent.go` + `pkg/agent/helpers.go` (plus `pkg/agent/suggest.go` for the
separate suggestions call). Runs a single user turn as a
bounded Bedrock **ConverseStream** tool-use loop, emitting `Event`s and streaming
text deltas token-by-token.

## `Event` (SSE payload from the backend)

```go
type Event struct {
    Type    string // "content" | "reasoning" | "tool_call" | "tool_result" | "status" | "done" | "error"
    Text    string // content/reasoning chunk
    ID      string // tool_use id (tool_call/tool_result)
    Server  string // owning MCP server (tool_call)
    Name    string // namespaced tool name (tool_call)
    Input   any    // tool input JSON (tool_call)
    Status  string // "running" | "completed" | "error" | free-form status
    Preview string // truncated tool output (tool_result completed)
    Output  string // full tool output, UI-capped at 20k chars (tool_result completed)
    Error   string // error text (tool_result error / error)
    Content string // full final answer (done)
}
```

Maps 1:1 to the frontend `AgentEvent` in `lib/protocol.ts` (see [07-protocol.md](./07-protocol.md)).

## `Agent`

```go
New(brc *bedrockruntime.Client, modelID, systemPrompt string,
    maxIterations, maxTools int, clients []*mcp.Client) *Agent
```

### `collectTools(ctx, browserTools)`
For each MCP client: `Initialize` + `ListTools`. Each tool becomes a Bedrock `ToolSpecification`:
- `Name = "<server>__<tool>"`
- `Description = tool.Description` (falls back to the tool **name** when empty, since Bedrock rejects empty descriptions).
- `InputSchema = Json(toJSONDocument(schema))` — the tool's JSON Schema, or a permissive `{type:object, properties:{}}` fallback.
Returns the `[]brtypes.Tool` plus a `map[namespacedName]toolBinding{client, realName}`.
If `maxTools > 0`, the advertised tool list is capped to that many (default 64) to avoid blowing the model's context window with hundreds of tool specs.
**Browser tools** (frontend-advertised, see [11](./11-browser-tools.md)) are appended *after* the cap as `browser__<name>` — they are never dropped and have no binding (they pause the loop instead of dispatching).

### `Run(ctx, userMessage, history, browserTools, emit)` / `Continue(ctx, token, results, browserTools, contextText, emit)`
`Run`:
1. `collectTools`; on error emit `error` and return.
2. `messages = buildMessages(history, userMessage)`.
3. Delegate to `loop(ctx, messages, 0, tools, bindings, emit)`.

`Continue` (resume after browser tools):
1. `decodeContinuation(token)` → messages + partial MCP results + pending browser tool ids + iteration index.
2. Build the tool-result user message: partial results first, then one `toolResult` per pending id (missing ids become error results — Bedrock requires a result for every `toolUse`), then `contextText` (post-action page context) as a trailing text block.
3. `collectTools` again (MCP clients re-init) and resume `loop` at the saved iteration.

### `loop(ctx, messages, startIter, tools, bindings, emit)`
Loop from `startIter` up to `maxIterations`, each iteration calling `streamTurn` (below):
- If `StopReason != tool_use` or no tool uses → emit `done` (empty payload; the
  client keeps its already-streamed text) and return.
- Partition tool uses into MCP vs `browser__*`.
- Run each MCP tool (`runTool`), collect `toolResult` blocks.
- If any browser tools were requested: emit one `browser_tool_call` per tool,
  serialize the conversation (+ the MCP results as partials) into a
  continuation token, emit `paused`, and **return** — the frontend resumes via
  `Continue`. See [pkg/agent/continuation.go] and [11-browser-tools.md](./11-browser-tools.md).
- Else append the results as a **user** message and continue.
If the loop exhausts `maxIterations` → emit `done`.

### `streamTurn(ctx, messages, system, toolConfig, emit)`
One `bedrock.ConverseStream(...)` call. Consumes the event stream:
- `ContentBlockStart` (tool_use) → record tool name + id for that block index.
- `ContentBlockDelta`:
  - text delta → accumulate **and** `emit(content)` immediately (real-time typewriter).
  - tool_use delta → accumulate the partial-JSON input string.
- `MessageStop` → capture `StopReason`.
Then rebuilds the assistant `Message` in content-block order (text blocks +
`ToolUse` blocks with parsed input) and returns it plus the tool_use blocks and
stop reason.

### `runTool(ctx, toolUse, bindings, emit)`
- Decodes the tool input document to JSON (`documentToJSON`).
- Emits `tool_call{running}`.
- Unknown tool → emit `tool_result{error}` and return an error `toolResult` block.
- Else `client.CallTool(realName, inputJSON)`:
  - error → emit `tool_result{error}`, return error `toolResult` block.
  - success → emit `tool_result{completed, preview, output}`, return `toolResult`
    block with the result passed through `capResult` (truncated to
    `maxToolResultChars = 8000` before feeding back to the model). The UI gets a
    280-rune `preview` plus the full `output` capped at
    `maxUIOutputChars = 20000` (`capUIOutput`), rendered as collapsible JSON.

## suggest.go (separate, non-loop path)

`Agent.Suggest(ctx, history, contextText, customContext)` is **not** part of the
tool-use loop: it makes one non-streaming `bedrock.Converse` call with **no
`ToolConfig`**, its own system prompt, `MaxTokens: 400` / `Temperature: 0.4`, and
parses a JSON array of follow-up prompts (capped at 4). It emits no `Event`s and
never calls tools. See [13-suggestions.md](./13-suggestions.md).

## helpers.go
- `buildMessages` — history + current message to `[]brtypes.Message`.
- `toolResultBlock(id, text, isError)` — a `ToolResultBlock` with success/error status.
- `toJSONDocument(map)` / `documentToJSON(doc)` — bridge between Go maps/JSON and Bedrock `document.Interface` (`bedrockruntime/document.NewLazyDocument`).
- `toolInputDocument(raw)` — builds a Bedrock document from the raw JSON string reassembled from streamed tool_use input deltas (empty object on parse failure).
- `preview(s)` — truncates to 280 runes with an ellipsis (used for `tool_result.preview`).
- `serverOf(name)` — splits a namespaced tool name on the first `__`.

`capUIOutput(s)` (agent.go) truncates the full result to `maxUIOutputChars = 20000`
for `tool_result.output` — render-only, looser than the 8000-char model cap.

## Current state / gaps

- **Streaming**: uses `ConverseStream`; text is emitted as `content` deltas
  token-by-token (verified). `done` carries no payload — the client keeps the
  text it already streamed.
- **Reasoning events**: `Event.Type == "reasoning"` is defined but the loop does
  not currently emit separate reasoning; only text blocks stream. If you enable
  Bedrock reasoning/thinking content, add a delta case in `streamTurn`.
- **No tool-permission gating**: all tools run automatically. Mutating-tool
  approval is not implemented. Tool **count** (`maxTools`) and result **size**
  (`capResult`) are bounded to protect the context window.
- **No per-tool timeout** beyond the 60s `http.Client` timeout shared across MCP calls.
