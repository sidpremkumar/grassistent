# 05 — Agent loop

`pkg/agent/agent.go` + `pkg/agent/helpers.go`. Runs a single user turn as a
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

### `collectTools(ctx)`
For each MCP client: `Initialize` + `ListTools`. Each tool becomes a Bedrock `ToolSpecification`:
- `Name = "<server>__<tool>"`
- `Description = tool.Description` (falls back to the tool **name** when empty, since Bedrock rejects empty descriptions).
- `InputSchema = Json(toJSONDocument(schema))` — the tool's JSON Schema, or a permissive `{type:object, properties:{}}` fallback.
Returns the `[]brtypes.Tool` plus a `map[namespacedName]toolBinding{client, realName}`.
If `maxTools > 0`, the advertised tool list is capped to that many (default 64) to avoid blowing the model's context window with hundreds of tool specs.

### `Run(ctx, userMessage, history, emit)`
1. `collectTools`; on error emit `error` and return.
2. `messages = buildMessages(history, userMessage)`.
3. Build optional `ToolConfiguration` and optional `System` block.
4. Loop up to `maxIterations`, each iteration calling `streamTurn` (below):
   - If `StopReason != tool_use` or no tool uses → emit `done` (empty payload; the
     client keeps its already-streamed text) and return.
   - Else run each tool (`runTool`), collect `toolResult` blocks, append as a
     **user** message, continue.
5. If the loop exhausts `maxIterations` → emit `done`.

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
  - success → emit `tool_result{completed, preview}`, return `toolResult` block
    with the result passed through `capResult` (truncated to
    `maxToolResultChars = 8000` before feeding back to the model; the UI still
    gets a short preview).

## helpers.go

- `buildMessages` — history + current message to `[]brtypes.Message`.
- `toolResultBlock(id, text, isError)` — a `ToolResultBlock` with success/error status.
- `toJSONDocument(map)` / `documentToJSON(doc)` — bridge between Go maps/JSON and Bedrock `document.Interface` (`bedrockruntime/document.NewLazyDocument`).
- `toolInputDocument(raw)` — builds a Bedrock document from the raw JSON string reassembled from streamed tool_use input deltas (empty object on parse failure).
- `preview(s)` — truncates to 280 runes with an ellipsis (used for `tool_result.preview`).
- `serverOf(name)` — splits a namespaced tool name on the first `__`.

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
