package agent

import (
	"encoding/json"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	brdoc "github.com/aws/aws-sdk-go-v2/service/bedrockruntime/document"
	brtypes "github.com/aws/aws-sdk-go-v2/service/bedrockruntime/types"
)

// Turn is a prior conversation message.
type Turn struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

func buildMessages(history []Turn, userMessage string) []brtypes.Message {
	var messages []brtypes.Message
	for _, t := range history {
		role := brtypes.ConversationRoleUser
		if t.Role == "assistant" {
			role = brtypes.ConversationRoleAssistant
		}
		messages = append(messages, brtypes.Message{
			Role:    role,
			Content: []brtypes.ContentBlock{&brtypes.ContentBlockMemberText{Value: t.Content}},
		})
	}
	messages = append(messages, brtypes.Message{
		Role:    brtypes.ConversationRoleUser,
		Content: []brtypes.ContentBlock{&brtypes.ContentBlockMemberText{Value: userMessage}},
	})
	return messages
}

func toolResultBlock(toolUseID, text string, isError bool) brtypes.ContentBlock {
	status := brtypes.ToolResultStatusSuccess
	if isError {
		status = brtypes.ToolResultStatusError
	}
	return &brtypes.ContentBlockMemberToolResult{
		Value: brtypes.ToolResultBlock{
			ToolUseId: aws.String(toolUseID),
			Status:    status,
			Content: []brtypes.ToolResultContentBlock{
				&brtypes.ToolResultContentBlockMemberText{Value: text},
			},
		},
	}
}

// appendUserText adds a user-role text message without mutating the caller's
// slice. Bedrock rejects two consecutive messages with the same role, so when
// the conversation already ends on a user message the text is folded into it.
func appendUserText(messages []brtypes.Message, text string) []brtypes.Message {
	out := make([]brtypes.Message, len(messages))
	copy(out, messages)

	if n := len(out); n > 0 && out[n-1].Role == brtypes.ConversationRoleUser {
		content := make([]brtypes.ContentBlock, len(out[n-1].Content), len(out[n-1].Content)+1)
		copy(content, out[n-1].Content)
		out[n-1].Content = append(content, &brtypes.ContentBlockMemberText{Value: text})
		return out
	}
	return append(out, brtypes.Message{
		Role:    brtypes.ConversationRoleUser,
		Content: []brtypes.ContentBlock{&brtypes.ContentBlockMemberText{Value: text}},
	})
}

// hasText reports whether a message carries any non-blank text block, i.e.
// whether the user actually saw prose stream from it.
func hasText(m brtypes.Message) bool {
	for _, block := range m.Content {
		if t, ok := block.(*brtypes.ContentBlockMemberText); ok && strings.TrimSpace(t.Value) != "" {
			return true
		}
	}
	return false
}

// toJSONDocument converts a JSON-shaped map into a Bedrock document for tool schemas.
func toJSONDocument(v map[string]any) brdoc.Interface {
	return brdoc.NewLazyDocument(v)
}

// toolInputDocument builds a Bedrock document from a raw JSON string. Used when
// reconstructing streamed tool_use blocks, whose input arrives as concatenated
// partial-JSON deltas. Falls back to an empty object on parse failure.
func toolInputDocument(raw string) brdoc.Interface {
	var v any
	if err := json.Unmarshal([]byte(raw), &v); err != nil {
		return brdoc.NewLazyDocument(map[string]any{})
	}
	return brdoc.NewLazyDocument(v)
}

// documentToJSON serializes a Bedrock document (tool input) back to JSON bytes.
func documentToJSON(doc brdoc.Interface) ([]byte, error) {
	if doc == nil {
		return []byte("{}"), nil
	}
	b, err := doc.MarshalSmithyDocument()
	if err != nil {
		return []byte("{}"), err
	}
	return b, nil
}

func preview(s string) string {
	const max = 280
	runes := []rune(s)
	if len(runes) <= max {
		return s
	}
	return string(runes[:max]) + "\u2026"
}

func serverOf(namespacedName string) string {
	for i := 0; i+1 < len(namespacedName); i++ {
		if namespacedName[i] == '_' && namespacedName[i+1] == '_' {
			return namespacedName[:i]
		}
	}
	return ""
}
