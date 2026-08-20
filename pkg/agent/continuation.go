package agent

import (
	"bytes"
	"compress/gzip"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"

	"github.com/aws/aws-sdk-go-v2/aws"
	brtypes "github.com/aws/aws-sdk-go-v2/service/bedrockruntime/types"
)

/*
 * Continuation support for browser-executed tools.
 *
 * When the model calls a browser tool, the loop cannot finish server-side: the
 * tool runs in the user's page and may block on human interaction for minutes.
 * Instead of holding the SSE stream open, we serialize the in-flight Bedrock
 * conversation into an opaque token, emit it with a "paused" event, and close
 * the stream. The frontend executes the tools and POSTs the token back together
 * with the results; Continue() rehydrates the conversation and resumes the loop.
 *
 * bedrockruntime types are interface-heavy and not JSON-serializable, so we
 * mirror the three content-block shapes the loop actually produces (text,
 * tool_use, tool_result) in owned structs.
 */

type serializedToolUse struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	InputJSON string `json:"input"`
}

type serializedToolResult struct {
	ID      string `json:"id"`
	Text    string `json:"text"`
	IsError bool   `json:"isError,omitempty"`
}

type serializedBlock struct {
	Text       string                `json:"text,omitempty"`
	ToolUse    *serializedToolUse    `json:"toolUse,omitempty"`
	ToolResult *serializedToolResult `json:"toolResult,omitempty"`
}

type serializedMessage struct {
	Role   string            `json:"role"`
	Blocks []serializedBlock `json:"blocks"`
}

// continuationState is everything needed to resume a paused agent loop.
type continuationState struct {
	Messages []serializedMessage `json:"messages"`
	// PartialResults are tool results for MCP tools that already executed
	// server-side in the same assistant turn that triggered the pause.
	PartialResults []serializedToolResult `json:"partialResults,omitempty"`
	// PendingIDs are the toolUse ids the browser must answer. Bedrock requires
	// a toolResult for every toolUse in the assistant message, so missing ids
	// are filled with error results on resume.
	PendingIDs []string `json:"pendingIds"`
	// Iter is the loop iteration to resume from (bounds the total turn).
	Iter int `json:"iter"`
}

func serializeMessages(messages []brtypes.Message) ([]serializedMessage, error) {
	out := make([]serializedMessage, 0, len(messages))
	for _, m := range messages {
		sm := serializedMessage{Role: string(m.Role)}
		for _, block := range m.Content {
			switch b := block.(type) {
			case *brtypes.ContentBlockMemberText:
				sm.Blocks = append(sm.Blocks, serializedBlock{Text: b.Value})
			case *brtypes.ContentBlockMemberToolUse:
				inputJSON, err := documentToJSON(b.Value.Input)
				if err != nil {
					return nil, fmt.Errorf("serialize tool_use input: %w", err)
				}
				sm.Blocks = append(sm.Blocks, serializedBlock{ToolUse: &serializedToolUse{
					ID:        aws.ToString(b.Value.ToolUseId),
					Name:      aws.ToString(b.Value.Name),
					InputJSON: string(inputJSON),
				}})
			case *brtypes.ContentBlockMemberToolResult:
				sm.Blocks = append(sm.Blocks, serializedBlock{ToolResult: serializeToolResult(&b.Value)})
			default:
				/* Unknown block types (images, documents) are not produced by
				 * this loop; drop them rather than failing the whole pause. */
			}
		}
		out = append(out, sm)
	}
	return out, nil
}

func serializeToolResult(tr *brtypes.ToolResultBlock) *serializedToolResult {
	var text string
	for _, c := range tr.Content {
		if t, ok := c.(*brtypes.ToolResultContentBlockMemberText); ok {
			text += t.Value
		}
	}
	return &serializedToolResult{
		ID:      aws.ToString(tr.ToolUseId),
		Text:    text,
		IsError: tr.Status == brtypes.ToolResultStatusError,
	}
}

func deserializeMessages(msgs []serializedMessage) []brtypes.Message {
	out := make([]brtypes.Message, 0, len(msgs))
	for _, sm := range msgs {
		role := brtypes.ConversationRoleUser
		if sm.Role == string(brtypes.ConversationRoleAssistant) {
			role = brtypes.ConversationRoleAssistant
		}
		m := brtypes.Message{Role: role}
		for _, b := range sm.Blocks {
			switch {
			case b.ToolUse != nil:
				m.Content = append(m.Content, &brtypes.ContentBlockMemberToolUse{
					Value: brtypes.ToolUseBlock{
						ToolUseId: aws.String(b.ToolUse.ID),
						Name:      aws.String(b.ToolUse.Name),
						Input:     toolInputDocument(b.ToolUse.InputJSON),
					},
				})
			case b.ToolResult != nil:
				m.Content = append(m.Content, toolResultBlock(b.ToolResult.ID, b.ToolResult.Text, b.ToolResult.IsError))
			default:
				m.Content = append(m.Content, &brtypes.ContentBlockMemberText{Value: b.Text})
			}
		}
		out = append(out, m)
	}
	return out
}

// encodeContinuation packs the state into an opaque URL-safe token (gzip+b64).
func encodeContinuation(state continuationState) (string, error) {
	raw, err := json.Marshal(state)
	if err != nil {
		return "", err
	}
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	if _, err := zw.Write(raw); err != nil {
		return "", err
	}
	if err := zw.Close(); err != nil {
		return "", err
	}
	return base64.URLEncoding.EncodeToString(buf.Bytes()), nil
}

func decodeContinuation(token string) (continuationState, error) {
	var state continuationState
	compressed, err := base64.URLEncoding.DecodeString(token)
	if err != nil {
		return state, fmt.Errorf("decode continuation: %w", err)
	}
	zr, err := gzip.NewReader(bytes.NewReader(compressed))
	if err != nil {
		return state, fmt.Errorf("decompress continuation: %w", err)
	}
	raw, err := io.ReadAll(io.LimitReader(zr, 8<<20))
	if err != nil {
		return state, fmt.Errorf("read continuation: %w", err)
	}
	if err := json.Unmarshal(raw, &state); err != nil {
		return state, fmt.Errorf("parse continuation: %w", err)
	}
	return state, nil
}
