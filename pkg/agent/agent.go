package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/bedrockruntime"
	brtypes "github.com/aws/aws-sdk-go-v2/service/bedrockruntime/types"
	"github.com/grafana/grafana-plugin-sdk-go/backend"

	"github.com/grafana-mcp-agent/mcpagent/pkg/mcp"
)

// Event is emitted by the agent loop and mapped to SSE frames by the caller.
type Event struct {
	Type    string `json:"type"`
	Text    string `json:"text,omitempty"`
	ID      string `json:"id,omitempty"`
	Server  string `json:"server,omitempty"`
	Name    string `json:"name,omitempty"`
	Input   any    `json:"input,omitempty"`
	Status  string `json:"status,omitempty"`
	Preview string `json:"preview,omitempty"`
	// Output is the full (UI-capped) tool result payload for rich rendering.
	Output  string `json:"output,omitempty"`
	Error   string `json:"error,omitempty"`
	Content string `json:"content,omitempty"`
	// Continuation is the opaque resume token carried by "paused" events.
	Continuation string `json:"continuation,omitempty"`
}

// BrowserToolSpec is a tool the frontend can execute in the user's page. The
// frontend advertises these per-request; the backend stays UI-agnostic.
type BrowserToolSpec struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"inputSchema"`
}

// BrowserToolResult is the outcome of one browser-executed tool call.
type BrowserToolResult struct {
	ID      string `json:"id"`
	Content string `json:"content"`
	IsError bool   `json:"isError,omitempty"`
}

// browserNamespace prefixes browser tools so the loop can recognize them as
// pause-points instead of dispatching them to an MCP client.
const browserNamespace = "browser__"

func isBrowserTool(name string) bool { return strings.HasPrefix(name, browserNamespace) }

// EmitFunc receives agent events as they happen.
type EmitFunc func(Event)

// toolBinding maps a namespaced tool name to the MCP client that owns it.
type toolBinding struct {
	client   *mcp.Client
	realName string
}

// ServerBinding pairs an MCP client with per-server operator configuration.
type ServerBinding struct {
	// Client is the initialized-on-demand MCP client for this server.
	Client *mcp.Client
	// AllowedTools, when non-empty, is an explicit allowlist of tool names (as
	// advertised by the server, before namespacing). Tools not listed are not
	// advertised to the model. Empty = expose every tool.
	AllowedTools []string
	// Context is operator-provided guidance on how the agent should use this
	// server's tools; appended to the system prompt.
	Context string
}

// Agent runs a Bedrock Converse tool-use loop against a set of MCP servers.
type Agent struct {
	bedrock       *bedrockruntime.Client
	modelID       string
	systemPrompt  string
	maxIterations int
	maxTools      int
	servers       []ServerBinding
}

// New builds an agent. Per-server operator context is folded into the system
// prompt so the model knows how to use each server's tools.
func New(brc *bedrockruntime.Client, modelID, systemPrompt string, maxIterations, maxTools int, servers []ServerBinding) *Agent {
	return &Agent{
		bedrock:       brc,
		modelID:       modelID,
		systemPrompt:  withServerContext(systemPrompt, servers),
		maxIterations: maxIterations,
		maxTools:      maxTools,
		servers:       servers,
	}
}

// withServerContext appends operator-provided per-server usage notes to the
// system prompt so users can steer how the agent queries each MCP server
// (e.g. which labels/services to use for "backend api logs").
//
// Operator notes are frequently copied from docs written for a different agent
// with a different tool namespace, so they name tools that do not exist here.
// The header below tells the model to treat the notes as domain knowledge and
// the tool list as the only source of callable names.
func withServerContext(systemPrompt string, servers []ServerBinding) string {
	var notes []string
	for _, s := range servers {
		ctx := strings.TrimSpace(s.Context)
		if ctx == "" {
			continue
		}
		notes = append(notes, fmt.Sprintf("[%s]\n%s", s.Client.Name(), ctx))
	}
	if len(notes) == 0 {
		return systemPrompt
	}
	return systemPrompt +
		"\n\nOperator notes per MCP server (follow these when choosing and calling that server's tools).\n" +
		"IMPORTANT — these notes are DOMAIN knowledge (which service, label, metric, datasource uid to " +
		"use), not a tool catalogue. Your tool list is the ONLY source of callable tool names: call every " +
		"tool by its exact advertised \"<server>__<tool>\" name. If a note references a tool name that is " +
		"not in your tool list, find the tool in your list that does the same job and use its real name; " +
		"never invent a name by combining a note's naming style with a server prefix.\n\n" +
		strings.Join(notes, "\n\n")
}

// namespaced tool names avoid collisions across MCP servers: "<server>__<tool>".
func namespaced(server, tool string) string { return server + "__" + tool }

// allowSet turns an allowlist into a lookup set; nil means "allow everything".
func allowSet(names []string) map[string]bool {
	set := map[string]bool{}
	for _, n := range names {
		n = strings.TrimSpace(n)
		if n != "" {
			set[n] = true
		}
	}
	if len(set) == 0 {
		return nil
	}
	return set
}

// collectTools initializes each MCP client and builds the Bedrock tool config.
// Per-server tool allowlists are applied here, before the MaxTools cap.
// Browser tools are appended after the MaxTools cap so advertising many MCP
// tools can never silently drop the frontend's capabilities.
func (a *Agent) collectTools(ctx context.Context, browserTools []BrowserToolSpec) ([]brtypes.Tool, map[string]toolBinding, error) {
	bindings := map[string]toolBinding{}

	/* Grouped per server rather than one flat slice so the MaxTools cap can be
	 * shared fairly: a flat truncation is first-server-wins, which silently
	 * hides EVERY tool of every later server once the first one is large. */
	perServer := make([][]brtypes.Tool, 0, len(a.servers))

	for _, server := range a.servers {
		client := server.Client
		if err := client.Initialize(ctx); err != nil {
			return nil, nil, fmt.Errorf("initialize %q: %w", client.Name(), err)
		}
		mcpTools, err := client.ListTools(ctx)
		if err != nil {
			return nil, nil, fmt.Errorf("list tools %q: %w", client.Name(), err)
		}
		allowed := allowSet(server.AllowedTools)
		var advertised []brtypes.Tool
		for _, t := range mcpTools {
			if allowed != nil && !allowed[t.Name] {
				continue
			}
			full := namespaced(client.Name(), t.Name)
			/* Bedrock rejects the ENTIRE Converse request when any tool spec
			 * name is malformed or over 64 chars, so one bad name from one
			 * server would break every turn. Drop it instead. */
			if !validToolName(full) {
				backend.Logger.Warn("skipping MCP tool with a name Bedrock cannot accept",
					"server", client.Name(), "tool", t.Name, "namespaced", full)
				continue
			}
			var schema map[string]any
			if len(t.InputSchema) > 0 {
				_ = json.Unmarshal(t.InputSchema, &schema)
			}
			if schema == nil {
				schema = map[string]any{"type": "object", "properties": map[string]any{}}
			}
			doc := toJSONDocument(schema)
			description := t.Description
			if strings.TrimSpace(description) == "" {
				/* Bedrock requires a non-empty tool description. */
				description = t.Name
			}
			advertised = append(advertised, &brtypes.ToolMemberToolSpec{
				Value: brtypes.ToolSpecification{
					Name:        aws.String(full),
					Description: aws.String(description),
					InputSchema: &brtypes.ToolInputSchemaMemberJson{Value: doc},
				},
			})
			bindings[full] = toolBinding{client: client, realName: t.Name}
		}
		backend.Logger.Debug("advertising MCP tools",
			"server", client.Name(), "advertised", len(advertised), "offered", len(mcpTools))
		perServer = append(perServer, advertised)
	}

	tools := capTools(perServer, a.maxTools)

	for _, bt := range browserTools {
		schema := bt.InputSchema
		if schema == nil {
			schema = map[string]any{"type": "object", "properties": map[string]any{}}
		}
		description := bt.Description
		if strings.TrimSpace(description) == "" {
			description = bt.Name
		}
		tools = append(tools, &brtypes.ToolMemberToolSpec{
			Value: brtypes.ToolSpecification{
				Name:        aws.String(browserNamespace + bt.Name),
				Description: aws.String(description),
				InputSchema: &brtypes.ToolInputSchemaMemberJson{Value: toJSONDocument(schema)},
			},
		})
	}
	return tools, bindings, nil
}

// capTools flattens per-server tool lists under a global cap, taking one tool
// from each server per pass so every configured server keeps representation.
// A dropped tool is invisible to the model but still named in operator context
// and docs, which is a direct cause of "unknown tool" loops — so any drop is
// logged loudly with the count.
func capTools(perServer [][]brtypes.Tool, maxTools int) []brtypes.Tool {
	total := 0
	longest := 0
	for _, group := range perServer {
		total += len(group)
		if len(group) > longest {
			longest = len(group)
		}
	}
	if maxTools <= 0 || total <= maxTools {
		flat := make([]brtypes.Tool, 0, total)
		for _, group := range perServer {
			flat = append(flat, group...)
		}
		return flat
	}

	backend.Logger.Warn(
		"MCP tool count exceeds maxTools; some tools will NOT be advertised to the model "+
			"(it may then call names it has read in operator context but cannot dispatch) — "+
			"raise maxTools or narrow each server's allowlist",
		"total", total, "maxTools", maxTools, "dropped", total-maxTools)

	flat := make([]brtypes.Tool, 0, maxTools)
	for i := 0; i < longest && len(flat) < maxTools; i++ {
		for _, group := range perServer {
			if i >= len(group) || len(flat) == maxTools {
				continue
			}
			flat = append(flat, group[i])
		}
	}
	return flat
}

// Run executes the agent loop for a single user turn, emitting events as it goes.
func (a *Agent) Run(ctx context.Context, userMessage string, history []Turn, browserTools []BrowserToolSpec, emit EmitFunc) error {
	tools, bindings, err := a.collectTools(ctx, browserTools)
	if err != nil {
		emit(Event{Type: "error", Error: err.Error()})
		return err
	}
	messages := buildMessages(history, userMessage)
	return a.loop(ctx, messages, 0, tools, bindings, emit)
}

// Continue resumes a loop paused on browser tool calls. contextText, when
// non-empty, is appended as an extra text block so the model sees the page
// state *after* its actions took effect (perception-action loop).
func (a *Agent) Continue(ctx context.Context, token string, results []BrowserToolResult, browserTools []BrowserToolSpec, contextText string, emit EmitFunc) error {
	state, err := decodeContinuation(token)
	if err != nil {
		emit(Event{Type: "error", Error: err.Error()})
		return err
	}
	messages := deserializeMessages(state.Messages)

	/* Bedrock requires one toolResult per toolUse in the assistant message:
	 * partial (server-side MCP) results first, then browser results keyed by
	 * pending id, with missing ids filled in as errors. */
	var resultBlocks []brtypes.ContentBlock
	for _, pr := range state.PartialResults {
		resultBlocks = append(resultBlocks, toolResultBlock(pr.ID, pr.Text, pr.IsError))
	}
	byID := make(map[string]BrowserToolResult, len(results))
	for _, r := range results {
		byID[r.ID] = r
	}
	for _, id := range state.PendingIDs {
		if r, ok := byID[id]; ok {
			resultBlocks = append(resultBlocks, toolResultBlock(id, capResult(r.Content), r.IsError))
		} else {
			resultBlocks = append(resultBlocks, toolResultBlock(id, "browser returned no result for this tool call", true))
		}
	}
	if strings.TrimSpace(contextText) != "" {
		resultBlocks = append(resultBlocks, &brtypes.ContentBlockMemberText{Value: contextText})
	}
	messages = append(messages, brtypes.Message{
		Role:    brtypes.ConversationRoleUser,
		Content: resultBlocks,
	})

	tools, bindings, err := a.collectTools(ctx, browserTools)
	if err != nil {
		emit(Event{Type: "error", Error: err.Error()})
		return err
	}
	return a.loop(ctx, messages, state.Iter, tools, bindings, emit)
}

// loop is the shared Bedrock Converse tool-use loop. It runs until the model
// stops calling tools, the iteration budget is exhausted, or a browser tool
// forces a pause.
func (a *Agent) loop(
	ctx context.Context,
	messages []brtypes.Message,
	startIter int,
	tools []brtypes.Tool,
	bindings map[string]toolBinding,
	emit EmitFunc,
) error {
	var toolConfig *brtypes.ToolConfiguration
	if len(tools) > 0 {
		toolConfig = &brtypes.ToolConfiguration{Tools: tools}
	}

	var system []brtypes.SystemContentBlock
	if a.systemPrompt != "" {
		system = []brtypes.SystemContentBlock{
			&brtypes.SystemContentBlockMemberText{Value: a.systemPrompt},
		}
	}

	/* The flat name list backs the "did you mean" hint on an unknown tool. It
	 * covers browser tools too, so a mis-namespaced page action is recoverable
	 * the same way. */
	toolNames := make([]string, 0, len(tools))
	for _, t := range tools {
		if spec, ok := t.(*brtypes.ToolMemberToolSpec); ok {
			toolNames = append(toolNames, aws.ToString(spec.Value.Name))
		}
	}

	for iter := startIter; iter < a.maxIterations; iter++ {
		assistantMsg, toolUses, stopReason, err := a.streamTurn(ctx, messages, system, toolConfig, emit)
		if err != nil {
			emit(Event{Type: "error", Error: err.Error()})
			return err
		}
		messages = append(messages, assistantMsg)

		if stopReason != brtypes.StopReasonToolUse || len(toolUses) == 0 {
			/* Text was already streamed via "content" deltas; signal completion
			 * without a payload so the client keeps its streamed answer. */
			emit(Event{Type: "done"})
			return nil
		}

		var mcpUses, browserUses []*brtypes.ContentBlockMemberToolUse
		for _, tu := range toolUses {
			if isBrowserTool(aws.ToString(tu.Value.Name)) {
				browserUses = append(browserUses, tu)
			} else {
				mcpUses = append(mcpUses, tu)
			}
		}

		/* Server-side MCP tools always run immediately. */
		var resultBlocks []brtypes.ContentBlock
		var partial []serializedToolResult
		for _, tu := range mcpUses {
			block := a.runTool(ctx, tu, bindings, toolNames, emit)
			resultBlocks = append(resultBlocks, block)
			if tr, ok := block.(*brtypes.ContentBlockMemberToolResult); ok {
				partial = append(partial, *serializeToolResult(&tr.Value))
			}
		}

		/* Browser tools pause the loop: hand the conversation to the frontend. */
		if len(browserUses) > 0 {
			pendingIDs := make([]string, 0, len(browserUses))
			for _, tu := range browserUses {
				id := aws.ToString(tu.Value.ToolUseId)
				pendingIDs = append(pendingIDs, id)
				inputJSON, _ := documentToJSON(tu.Value.Input)
				emit(Event{
					Type:   "browser_tool_call",
					ID:     id,
					Server: "browser",
					Name:   strings.TrimPrefix(aws.ToString(tu.Value.Name), browserNamespace),
					Input:  json.RawMessage(inputJSON),
					Status: "running",
				})
			}
			serialized, err := serializeMessages(messages)
			if err != nil {
				emit(Event{Type: "error", Error: err.Error()})
				return err
			}
			token, err := encodeContinuation(continuationState{
				Messages:       serialized,
				PartialResults: partial,
				PendingIDs:     pendingIDs,
				Iter:           iter + 1,
			})
			if err != nil {
				emit(Event{Type: "error", Error: err.Error()})
				return err
			}
			emit(Event{Type: "paused", Continuation: token})
			return nil
		}

		messages = append(messages, brtypes.Message{
			Role:    brtypes.ConversationRoleUser,
			Content: resultBlocks,
		})
	}

	emit(Event{Type: "done"})
	return nil
}

// streamTurn performs one ConverseStream call, emitting text deltas as "content"
// events in real time. It reconstructs the assistant message (text + tool_use
// blocks) so the loop can append tool results and continue, and returns any
// tool_use blocks together with the stop reason.
func (a *Agent) streamTurn(
	ctx context.Context,
	messages []brtypes.Message,
	system []brtypes.SystemContentBlock,
	toolConfig *brtypes.ToolConfiguration,
	emit EmitFunc,
) (brtypes.Message, []*brtypes.ContentBlockMemberToolUse, brtypes.StopReason, error) {
	out, err := a.bedrock.ConverseStream(ctx, &bedrockruntime.ConverseStreamInput{
		ModelId:    aws.String(a.modelID),
		Messages:   messages,
		System:     system,
		ToolConfig: toolConfig,
	})
	if err != nil {
		return brtypes.Message{}, nil, "", err
	}

	/* Bedrock streams content block-by-block, keyed by contentBlockIndex.
	 * Text blocks arrive as text deltas; tool_use blocks arrive as a start
	 * (with name + id) followed by partial-JSON input deltas that we must
	 * concatenate and parse when the block stops. */
	type blockAccumulator struct {
		isToolUse bool
		text      strings.Builder
		toolName  string
		toolID    string
		toolInput strings.Builder
	}
	blocks := map[int32]*blockAccumulator{}
	get := func(i int32) *blockAccumulator {
		b, ok := blocks[i]
		if !ok {
			b = &blockAccumulator{}
			blocks[i] = b
		}
		return b
	}

	var stopReason brtypes.StopReason
	stream := out.GetStream()
	defer stream.Close()

	for streamEvent := range stream.Events() {
		switch e := streamEvent.(type) {
		case *brtypes.ConverseStreamOutputMemberContentBlockStart:
			if start, ok := e.Value.Start.(*brtypes.ContentBlockStartMemberToolUse); ok {
				b := get(aws.ToInt32(e.Value.ContentBlockIndex))
				b.isToolUse = true
				b.toolName = aws.ToString(start.Value.Name)
				b.toolID = aws.ToString(start.Value.ToolUseId)
			}
		case *brtypes.ConverseStreamOutputMemberContentBlockDelta:
			b := get(aws.ToInt32(e.Value.ContentBlockIndex))
			switch d := e.Value.Delta.(type) {
			case *brtypes.ContentBlockDeltaMemberText:
				if d.Value != "" {
					b.text.WriteString(d.Value)
					emit(Event{Type: "content", Text: d.Value})
				}
			case *brtypes.ContentBlockDeltaMemberToolUse:
				b.toolInput.WriteString(aws.ToString(d.Value.Input))
			}
		case *brtypes.ConverseStreamOutputMemberMessageStop:
			stopReason = e.Value.StopReason
		}
	}
	if err := stream.Err(); err != nil {
		return brtypes.Message{}, nil, "", err
	}

	/* Rebuild the assistant message in content-block order. */
	assistant := brtypes.Message{Role: brtypes.ConversationRoleAssistant}
	var toolUses []*brtypes.ContentBlockMemberToolUse
	maxIdx := int32(-1)
	for i := range blocks {
		if i > maxIdx {
			maxIdx = i
		}
	}
	for i := int32(0); i <= maxIdx; i++ {
		b, ok := blocks[i]
		if !ok {
			continue
		}
		if b.isToolUse {
			raw := b.toolInput.String()
			if strings.TrimSpace(raw) == "" {
				raw = "{}"
			}
			/* The assistant message is echoed back on the next iteration and
			 * Bedrock validates toolUse names on INPUT too, so an illegal name
			 * (we have seen a literal "$PARAMETER_NAME") turns a recoverable
			 * "unknown tool" into a 400 that kills the whole turn mid-answer. */
			name := sanitizeToolName(b.toolName)
			tu := &brtypes.ContentBlockMemberToolUse{
				Value: brtypes.ToolUseBlock{
					Name:      aws.String(name),
					ToolUseId: aws.String(b.toolID),
					Input:     toolInputDocument(raw),
				},
			}
			assistant.Content = append(assistant.Content, tu)
			toolUses = append(toolUses, tu)
		} else if b.text.Len() > 0 {
			assistant.Content = append(assistant.Content,
				&brtypes.ContentBlockMemberText{Value: b.text.String()})
		}
	}

	return assistant, toolUses, stopReason, nil
}

// runTool executes a single tool_use block and returns the toolResult content block.
func (a *Agent) runTool(
	ctx context.Context,
	tu *brtypes.ContentBlockMemberToolUse,
	bindings map[string]toolBinding,
	toolNames []string,
	emit EmitFunc,
) brtypes.ContentBlock {
	name := aws.ToString(tu.Value.Name)
	toolUseID := aws.ToString(tu.Value.ToolUseId)

	inputJSON, _ := documentToJSON(tu.Value.Input)
	binding, known := bindings[name]

	emit(Event{
		Type:   "tool_call",
		ID:     toolUseID,
		Server: serverOf(name),
		Name:   name,
		Input:  json.RawMessage(inputJSON),
		Status: "running",
	})

	if !known {
		/* Hand the model the real names instead of a dead end, or it will burn
		 * the whole iteration budget retrying variations of the same guess. */
		msg := unknownToolMessage(name, toolNames)
		emit(Event{Type: "tool_result", ID: toolUseID, Status: "error", Error: msg})
		return toolResultBlock(toolUseID, msg, true)
	}

	text, isErr, err := binding.client.CallTool(ctx, binding.realName, json.RawMessage(inputJSON))
	if err != nil {
		emit(Event{Type: "tool_result", ID: toolUseID, Status: "error", Error: err.Error()})
		return toolResultBlock(toolUseID, err.Error(), true)
	}
	emit(Event{Type: "tool_result", ID: toolUseID, Status: "completed", Preview: preview(text), Output: capUIOutput(text)})
	/* Bound the result fed back to the model to avoid context overflow. */
	return toolResultBlock(toolUseID, capResult(text), isErr)
}

// maxToolResultChars caps a single tool result before it is added to the model
// context. Large observability payloads (e.g. service lists) otherwise blow the
// context window. The UI still receives a short preview via the event stream.
const maxToolResultChars = 8000

func capResult(s string) string {
	runes := []rune(s)
	if len(runes) <= maxToolResultChars {
		return s
	}
	return string(runes[:maxToolResultChars]) + "\n\n[truncated: result exceeded " +
		fmt.Sprintf("%d", maxToolResultChars) + " chars]"
}

// maxUIOutputChars caps the full tool output shipped to the UI over SSE. It is
// looser than the model cap since it is render-only, but still bounded so one
// huge payload can't bloat the stream or browser localStorage.
const maxUIOutputChars = 20000

func capUIOutput(s string) string {
	runes := []rune(s)
	if len(runes) <= maxUIOutputChars {
		return s
	}
	return string(runes[:maxUIOutputChars]) + "\n\n[truncated: output exceeded " +
		fmt.Sprintf("%d", maxUIOutputChars) + " chars]"
}
