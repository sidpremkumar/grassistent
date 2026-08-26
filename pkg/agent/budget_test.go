package agent

import (
	"strings"
	"testing"

	brtypes "github.com/aws/aws-sdk-go-v2/service/bedrockruntime/types"
)

func userMsg(text string) brtypes.Message {
	return brtypes.Message{
		Role:    brtypes.ConversationRoleUser,
		Content: []brtypes.ContentBlock{&brtypes.ContentBlockMemberText{Value: text}},
	}
}

func assistantMsg(text string) brtypes.Message {
	return brtypes.Message{
		Role:    brtypes.ConversationRoleAssistant,
		Content: []brtypes.ContentBlock{&brtypes.ContentBlockMemberText{Value: text}},
	}
}

func texts(m brtypes.Message) []string {
	var out []string
	for _, b := range m.Content {
		if t, ok := b.(*brtypes.ContentBlockMemberText); ok {
			out = append(out, t.Value)
		}
	}
	return out
}

func TestAppendUserTextAfterAssistant(t *testing.T) {
	in := []brtypes.Message{userMsg("q"), assistantMsg("a")}
	got := appendUserText(in, "wrap up")

	if len(got) != 3 {
		t.Fatalf("appendUserText produced %d messages, want 3", len(got))
	}
	if got[2].Role != brtypes.ConversationRoleUser {
		t.Fatalf("appended message role = %q, want user", got[2].Role)
	}
	if len(in) != 2 {
		t.Fatalf("appendUserText mutated the caller's slice (len %d)", len(in))
	}
}

func TestAppendUserTextFoldsIntoTrailingUserMessage(t *testing.T) {
	/* Bedrock rejects two consecutive user messages, which is exactly what the
	 * exhausted-budget path would hit: the loop's last append is the user-role
	 * tool-results message. */
	in := []brtypes.Message{userMsg("q"), assistantMsg("a"), userMsg("tool results")}
	got := appendUserText(in, "wrap up")

	if len(got) != 3 {
		t.Fatalf("appendUserText produced %d messages, want 3 (must not add a second user message)", len(got))
	}
	body := texts(got[2])
	if len(body) != 2 || body[0] != "tool results" || body[1] != "wrap up" {
		t.Fatalf("trailing user message blocks = %#v, want [tool results, wrap up]", body)
	}
	/* The original message must be untouched, not appended to in place. */
	if orig := texts(in[2]); len(orig) != 1 {
		t.Fatalf("appendUserText mutated the caller's content blocks: %#v", orig)
	}
}

func TestAppendUserTextOnEmptyConversation(t *testing.T) {
	got := appendUserText(nil, "wrap up")
	if len(got) != 1 || got[0].Role != brtypes.ConversationRoleUser {
		t.Fatalf("appendUserText(nil) = %#v, want one user message", got)
	}
}

func TestHasText(t *testing.T) {
	if hasText(brtypes.Message{}) {
		t.Fatal("hasText on an empty message = true, want false")
	}
	if hasText(userMsg("   \n\t ")) {
		t.Fatal("hasText on a whitespace-only message = true, want false")
	}
	if !hasText(userMsg("real answer")) {
		t.Fatal("hasText on a text message = false, want true")
	}

	/* A turn that only called tools has no prose, so the user saw nothing —
	 * this is the case that must trigger the fallback text. */
	toolOnly := brtypes.Message{
		Role:    brtypes.ConversationRoleAssistant,
		Content: []brtypes.ContentBlock{&brtypes.ContentBlockMemberToolUse{}},
	}
	if hasText(toolOnly) {
		t.Fatal("hasText on a tool-use-only message = true, want false")
	}
}

func TestBudgetExhaustedInstructionForbidsMoreTools(t *testing.T) {
	msg := budgetExhaustedInstruction
	for _, want := range []string{"CANNOT call any more tools", "%d tool steps"} {
		if !strings.Contains(msg, want) {
			t.Fatalf("budgetExhaustedInstruction is missing %q:\n%s", want, msg)
		}
	}
}

func TestExhaustedFallbackTextIsUserFacing(t *testing.T) {
	if strings.TrimSpace(exhaustedFallbackText) == "" {
		t.Fatal("exhaustedFallbackText is empty, which is the silent-stop bug it exists to prevent")
	}
	if !strings.Contains(exhaustedFallbackText, "Ask again") {
		t.Fatalf("exhaustedFallbackText should tell the user how to proceed:\n%s", exhaustedFallbackText)
	}
}
