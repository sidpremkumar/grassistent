package agent

import (
	"strings"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	brtypes "github.com/aws/aws-sdk-go-v2/service/bedrockruntime/types"
)

/* The tool names the Vitalize "skippy" server actually advertises, alongside the
 * names its operator context (written for a different agent) uses. This is the
 * exact shape of the production failure these helpers exist for. */
var skippyTools = []string{
	"skippy__list_alert_rules",
	"skippy__list_alert_groups",
	"skippy__query_prometheus",
	"skippy__query_loki_logs",
	"skippy__list_loki_label_values",
	"browser__open_explore",
	"browser__update_panel_query",
}

func TestSuggestToolsRecoversWrongPrefix(t *testing.T) {
	cases := []struct {
		wanted string
		want   string
	}{
		{wanted: "skippy__grafana_list_alert_rules", want: "skippy__list_alert_rules"},
		{wanted: "skippy__grafana_list_alert_groups", want: "skippy__list_alert_groups"},
		{wanted: "skippy__grafana_query_prometheus", want: "skippy__query_prometheus"},
		/* Right tool, wrong (or missing) server namespace. */
		{wanted: "query_loki_logs", want: "skippy__query_loki_logs"},
		{wanted: "vitalize__query_prometheus", want: "skippy__query_prometheus"},
	}

	for _, tc := range cases {
		t.Run(tc.wanted, func(t *testing.T) {
			got := suggestTools(tc.wanted, skippyTools)
			if len(got) == 0 {
				t.Fatalf("suggestTools(%q) returned no suggestions", tc.wanted)
			}
			if got[0] != tc.want {
				t.Fatalf("suggestTools(%q) top suggestion = %q, want %q (all: %v)",
					tc.wanted, got[0], tc.want, got)
			}
		})
	}
}

func TestSuggestToolsCaps(t *testing.T) {
	many := make([]string, 0, 40)
	for i := 0; i < 40; i++ {
		many = append(many, "srv__query_prometheus_"+string(rune('a'+i%26)))
	}
	got := suggestTools("srv__query_prometheus", many)
	if len(got) > maxToolSuggestions {
		t.Fatalf("suggestTools returned %d suggestions, want <= %d", len(got), maxToolSuggestions)
	}
}

func TestUnknownToolMessageIsActionable(t *testing.T) {
	msg := unknownToolMessage("skippy__grafana_list_alert_rules", skippyTools)
	if !strings.Contains(msg, "skippy__list_alert_rules") {
		t.Fatalf("message does not name the real tool:\n%s", msg)
	}
	if !strings.Contains(msg, "Did you mean") {
		t.Fatalf("message does not offer alternatives:\n%s", msg)
	}
}

func TestUnknownToolMessageTellsModelToStopGuessing(t *testing.T) {
	msg := unknownToolMessage("$PARAMETER_NAME", skippyTools)
	/* Nothing resembles it, so the model must be told to stop rather than
	 * handed a list of unrelated names to try. */
	if !strings.Contains(msg, "Do not guess") {
		t.Fatalf("message should tell the model to stop guessing:\n%s", msg)
	}
}

func TestSanitizeToolName(t *testing.T) {
	cases := []struct{ in, want string }{
		{in: "skippy__query_prometheus", want: "skippy__query_prometheus"},
		{in: "with-dashes-9", want: "with-dashes-9"},
		{in: "$PARAMETER_NAME", want: "_PARAMETER_NAME"},
		{in: "has spaces", want: "has_spaces"},
		{in: "tool.with.dots", want: "tool_with_dots"},
		{in: "", want: "unknown_tool"},
		{in: "$$$", want: "___"},
		{in: strings.Repeat("a", 100), want: strings.Repeat("a", 64)},
	}
	for _, tc := range cases {
		t.Run(tc.in, func(t *testing.T) {
			got := sanitizeToolName(tc.in)
			if got != tc.want {
				t.Fatalf("sanitizeToolName(%q) = %q, want %q", tc.in, got, tc.want)
			}
			if !validToolName(got) {
				t.Fatalf("sanitizeToolName(%q) = %q, which Bedrock would still reject", tc.in, got)
			}
		})
	}
}

func spec(name string) brtypes.Tool {
	return &brtypes.ToolMemberToolSpec{
		Value: brtypes.ToolSpecification{Name: aws.String(name)},
	}
}

func specNames(tools []brtypes.Tool) []string {
	out := make([]string, 0, len(tools))
	for _, t := range tools {
		if s, ok := t.(*brtypes.ToolMemberToolSpec); ok {
			out = append(out, aws.ToString(s.Value.Name))
		}
	}
	return out
}

func TestCapToolsKeepsEveryServerRepresented(t *testing.T) {
	/* A flat truncation would advertise only "a__" tools and hide server b
	 * entirely — the model then calls b's tools by name and cannot dispatch. */
	groups := [][]brtypes.Tool{
		{spec("a__1"), spec("a__2"), spec("a__3"), spec("a__4")},
		{spec("b__1"), spec("b__2")},
	}
	got := specNames(capTools(groups, 3))
	if len(got) != 3 {
		t.Fatalf("capTools returned %d tools, want 3 (%v)", len(got), got)
	}
	var sawA, sawB bool
	for _, n := range got {
		sawA = sawA || strings.HasPrefix(n, "a__")
		sawB = sawB || strings.HasPrefix(n, "b__")
	}
	if !sawA || !sawB {
		t.Fatalf("capTools dropped a whole server: %v", got)
	}
}

func TestCapToolsUncappedAndUnderCap(t *testing.T) {
	groups := [][]brtypes.Tool{{spec("a__1"), spec("a__2")}, {spec("b__1")}}
	if got := specNames(capTools(groups, 0)); len(got) != 3 {
		t.Fatalf("capTools with maxTools=0 returned %v, want all 3", got)
	}
	if got := specNames(capTools(groups, 10)); len(got) != 3 {
		t.Fatalf("capTools under cap returned %v, want all 3", got)
	}
}
