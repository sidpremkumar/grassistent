package agent

import (
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	brtypes "github.com/aws/aws-sdk-go-v2/service/bedrockruntime/types"
)

func TestContinuationRoundTrip(t *testing.T) {
	messages := []brtypes.Message{
		{
			Role: brtypes.ConversationRoleUser,
			Content: []brtypes.ContentBlock{
				&brtypes.ContentBlockMemberText{Value: "update this query"},
			},
		},
		{
			Role: brtypes.ConversationRoleAssistant,
			Content: []brtypes.ContentBlock{
				&brtypes.ContentBlockMemberText{Value: "I'll set the time range."},
				&brtypes.ContentBlockMemberToolUse{
					Value: brtypes.ToolUseBlock{
						ToolUseId: aws.String("tu-1"),
						Name:      aws.String("browser__set_time_range"),
						Input:     toolInputDocument(`{"from":"now-1h","to":"now"}`),
					},
				},
			},
		},
	}

	serialized, err := serializeMessages(messages)
	if err != nil {
		t.Fatalf("serialize: %v", err)
	}
	token, err := encodeContinuation(continuationState{
		Messages:       serialized,
		PartialResults: []serializedToolResult{{ID: "tu-0", Text: "mcp result", IsError: false}},
		PendingIDs:     []string{"tu-1"},
		Iter:           3,
	})
	if err != nil {
		t.Fatalf("encode: %v", err)
	}

	state, err := decodeContinuation(token)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if state.Iter != 3 || len(state.PendingIDs) != 1 || state.PendingIDs[0] != "tu-1" {
		t.Fatalf("state mismatch: %+v", state)
	}
	if len(state.PartialResults) != 1 || state.PartialResults[0].Text != "mcp result" {
		t.Fatalf("partial results mismatch: %+v", state.PartialResults)
	}

	restored := deserializeMessages(state.Messages)
	if len(restored) != 2 {
		t.Fatalf("expected 2 messages, got %d", len(restored))
	}
	if restored[1].Role != brtypes.ConversationRoleAssistant {
		t.Fatalf("role mismatch: %v", restored[1].Role)
	}
	tu, ok := restored[1].Content[1].(*brtypes.ContentBlockMemberToolUse)
	if !ok {
		t.Fatalf("expected tool_use block, got %T", restored[1].Content[1])
	}
	if aws.ToString(tu.Value.Name) != "browser__set_time_range" || aws.ToString(tu.Value.ToolUseId) != "tu-1" {
		t.Fatalf("tool_use mismatch: %v %v", aws.ToString(tu.Value.Name), aws.ToString(tu.Value.ToolUseId))
	}
	inputJSON, err := documentToJSON(tu.Value.Input)
	if err != nil {
		t.Fatalf("input json: %v", err)
	}
	if string(inputJSON) != `{"from":"now-1h","to":"now"}` {
		t.Fatalf("input mismatch: %s", inputJSON)
	}
}

func TestDecodeContinuationRejectsGarbage(t *testing.T) {
	if _, err := decodeContinuation("not-a-token"); err == nil {
		t.Fatal("expected error for invalid token")
	}
}
