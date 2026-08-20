package agent

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/bedrockruntime"
	brtypes "github.com/aws/aws-sdk-go-v2/service/bedrockruntime/types"

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
	Error   string `json:"error,omitempty"`
	Content string `json:"content,omitempty"`
}

// EmitFunc receives agent events as they happen.
type EmitFunc func(Event)

// toolBinding maps a namespaced tool name to the MCP client that owns it.
type toolBinding struct {
	client   *mcp.Client
	realName string
}

// Agent runs a Bedrock Converse tool-use loop against a set of MCP servers.
type Agent struct {
	bedrock       *bedrockruntime.Client
	modelID       string
	systemPrompt  string
	maxIterations int
	clients       []*mcp.Client
}

// New builds an agent.
func New(brc *bedrockruntime.Client, modelID, systemPrompt string, maxIterations int, clients []*mcp.Client) *Agent {
	return &Agent{
		bedrock:       brc,
		modelID:       modelID,
		systemPrompt:  systemPrompt,
		maxIterations: maxIterations,
		clients:       clients,
	}
}

// namespaced tool names avoid collisions across MCP servers: "<server>__<tool>".
func namespaced(server, tool string) string { return server + "__" + tool }

// collectTools initializes each MCP client and builds the Bedrock tool config.
func (a *Agent) collectTools(ctx context.Context) ([]brtypes.Tool, map[string]toolBinding, error) {
	var tools []brtypes.Tool
	bindings := map[string]toolBinding{}

	for _, client := range a.clients {
		if err := client.Initialize(ctx); err != nil {
			return nil, nil, fmt.Errorf("initialize %q: %w", client.Name(), err)
		}
		mcpTools, err := client.ListTools(ctx)
		if err != nil {
			return nil, nil, fmt.Errorf("list tools %q: %w", client.Name(), err)
		}
		for _, t := range mcpTools {
			full := namespaced(client.Name(), t.Name)
			var schema map[string]any
			if len(t.InputSchema) > 0 {
				_ = json.Unmarshal(t.InputSchema, &schema)
			}
			if schema == nil {
				schema = map[string]any{"type": "object", "properties": map[string]any{}}
			}
			doc := toJSONDocument(schema)
			tools = append(tools, &brtypes.ToolMemberToolSpec{
				Value: brtypes.ToolSpecification{
					Name:        aws.String(full),
					Description: aws.String(t.Description),
					InputSchema: &brtypes.ToolInputSchemaMemberJson{Value: doc},
				},
			})
			bindings[full] = toolBinding{client: client, realName: t.Name}
		}
	}
	return tools, bindings, nil
}

// Run executes the agent loop for a single user turn, emitting events as it goes.
func (a *Agent) Run(ctx context.Context, userMessage string, history []Turn, emit EmitFunc) error {
	tools, bindings, err := a.collectTools(ctx)
	if err != nil {
		emit(Event{Type: "error", Error: err.Error()})
		return err
	}

	messages := buildMessages(history, userMessage)

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

	var finalAnswer string

	for iter := 0; iter < a.maxIterations; iter++ {
		out, err := a.bedrock.Converse(ctx, &bedrockruntime.ConverseInput{
			ModelId:    aws.String(a.modelID),
			Messages:   messages,
			System:     system,
			ToolConfig: toolConfig,
		})
		if err != nil {
			emit(Event{Type: "error", Error: err.Error()})
			return err
		}

		assistantMsg, ok := out.Output.(*brtypes.ConverseOutputMemberMessage)
		if !ok {
			err := fmt.Errorf("unexpected converse output")
			emit(Event{Type: "error", Error: err.Error()})
			return err
		}
		messages = append(messages, assistantMsg.Value)

		var toolUses []*brtypes.ContentBlockMemberToolUse
		for _, block := range assistantMsg.Value.Content {
			switch b := block.(type) {
			case *brtypes.ContentBlockMemberText:
				if b.Value != "" {
					emit(Event{Type: "content", Text: b.Value})
					finalAnswer += b.Value
				}
			case *brtypes.ContentBlockMemberToolUse:
				toolUses = append(toolUses, b)
			}
		}

		if out.StopReason != brtypes.StopReasonToolUse || len(toolUses) == 0 {
			emit(Event{Type: "done", Content: finalAnswer})
			return nil
		}

		var resultBlocks []brtypes.ContentBlock
		for _, tu := range toolUses {
			resultBlocks = append(resultBlocks, a.runTool(ctx, tu, bindings, emit))
		}
		messages = append(messages, brtypes.Message{
			Role:    brtypes.ConversationRoleUser,
			Content: resultBlocks,
		})
	}

	emit(Event{Type: "done", Content: finalAnswer})
	return nil
}

// runTool executes a single tool_use block and returns the toolResult content block.
func (a *Agent) runTool(
	ctx context.Context,
	tu *brtypes.ContentBlockMemberToolUse,
	bindings map[string]toolBinding,
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
		msg := fmt.Sprintf("unknown tool %q", name)
		emit(Event{Type: "tool_result", ID: toolUseID, Status: "error", Error: msg})
		return toolResultBlock(toolUseID, msg, true)
	}

	text, isErr, err := binding.client.CallTool(ctx, binding.realName, json.RawMessage(inputJSON))
	if err != nil {
		emit(Event{Type: "tool_result", ID: toolUseID, Status: "error", Error: err.Error()})
		return toolResultBlock(toolUseID, err.Error(), true)
	}
	emit(Event{Type: "tool_result", ID: toolUseID, Status: "completed", Preview: preview(text)})
	return toolResultBlock(toolUseID, text, isErr)
}
