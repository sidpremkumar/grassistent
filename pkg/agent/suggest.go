package agent

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/bedrockruntime"
	brtypes "github.com/aws/aws-sdk-go-v2/service/bedrockruntime/types"
)

/*
suggestSystemPrompt steers the model to produce at most a couple of genuinely
useful follow-up prompts — or none at all. It must return ONLY a JSON array of
strings so the caller can parse deterministically; the temperature is kept low
for stable, grounded output.
*/
const suggestSystemPrompt = `You suggest the next thing a user might want to ask an observability agent embedded in Grafana.

You are given the recent conversation, the Grafana page the user is looking at, and optional user-provided guidance.

BE EXTREMELY PICKY. An empty list is a GOOD answer. Returning nothing is far better than returning a generic or tangential suggestion. Do not pad. Do not try to fill a quota.

Return 1 suggestion normally, 2 only when there are genuinely two distinct next steps that are both obviously valuable, and 0 whenever nothing clearly useful follows.

A suggestion QUALIFIES only if ALL of these hold:
- It follows directly from what just happened in this conversation — the actual query, panel, datasource, service, label, or error that was discussed. If you cannot name a concrete thing from the context in it, drop it.
- It is the obvious next move a competent engineer would make right now, not merely something adjacent or possible.
- It is not a rephrasing of something already asked or already answered.
- It is not generic observability filler ("check the logs", "look at other services", "try a different time range", "set up an alert") unless the conversation specifically points there.

Format: phrased as something the user would type, max ~90 characters, no numbering, no trailing punctuation clutter.

If the user provided guidance, let it shape the suggestions.

Return ONLY a compact JSON array of 0, 1, or 2 strings. No prose, no code fences, no keys. Examples: ["Break down that p99 by route"] or []`

/*
Suggest performs a single, tool-less model call to generate follow-up prompt
suggestions from the recent conversation, page context, and optional
user-provided custom context. It returns at most maxSuggestions strings, and an
empty slice (nil error) when the model returns nothing usable.
*/
func (a *Agent) Suggest(ctx context.Context, history []Turn, contextText, customContext string) ([]string, error) {
	prompt := buildSuggestPrompt(history, contextText, customContext)

	messages := []brtypes.Message{{
		Role:    brtypes.ConversationRoleUser,
		Content: []brtypes.ContentBlock{&brtypes.ContentBlockMemberText{Value: prompt}},
	}}

	out, err := a.bedrock.Converse(ctx, &bedrockruntime.ConverseInput{
		ModelId:  aws.String(a.modelID),
		Messages: messages,
		System: []brtypes.SystemContentBlock{
			&brtypes.SystemContentBlockMemberText{Value: suggestSystemPrompt},
		},
		InferenceConfig: &brtypes.InferenceConfiguration{
			MaxTokens:   aws.Int32(200),
			Temperature: aws.Float32(0.2),
		},
	})
	if err != nil {
		return nil, err
	}

	return parseSuggestions(converseText(out)), nil
}

// maxSuggestions caps how many prompts we return regardless of model output.
// Deliberately tight: one strong suggestion beats a list of weak ones, and zero
// is an acceptable outcome.
const maxSuggestions = 2

// buildSuggestPrompt assembles the single user message given to the model.
func buildSuggestPrompt(history []Turn, contextText, customContext string) string {
	var b strings.Builder
	if strings.TrimSpace(customContext) != "" {
		b.WriteString("[User-provided guidance]\n")
		b.WriteString(strings.TrimSpace(customContext))
		b.WriteString("\n\n")
	}
	if strings.TrimSpace(contextText) != "" {
		b.WriteString("[Grafana page context]\n")
		b.WriteString(strings.TrimSpace(contextText))
		b.WriteString("\n\n")
	}
	if len(history) > 0 {
		b.WriteString("[Recent conversation]\n")
		for _, t := range history {
			role := "User"
			if t.Role == "assistant" {
				role = "Assistant"
			}
			b.WriteString(role)
			b.WriteString(": ")
			b.WriteString(strings.TrimSpace(t.Content))
			b.WriteString("\n")
		}
		b.WriteString("\n")
	}
	if b.Len() == 0 {
		b.WriteString("There is no conversation or page context yet. ")
	}
	b.WriteString("Suggest at most 2 next prompts as a JSON array of strings, or [] if nothing is clearly worth suggesting.")
	return b.String()
}

// converseText extracts the assistant's text from a non-streaming Converse call.
func converseText(out *bedrockruntime.ConverseOutput) string {
	if out == nil {
		return ""
	}
	msg, ok := out.Output.(*brtypes.ConverseOutputMemberMessage)
	if !ok {
		return ""
	}
	var b strings.Builder
	for _, block := range msg.Value.Content {
		if t, ok := block.(*brtypes.ContentBlockMemberText); ok {
			b.WriteString(t.Value)
		}
	}
	return b.String()
}

/*
parseSuggestions extracts a JSON array of strings from the model output. The
model is instructed to return only a JSON array, but we defensively slice from
the first '[' to the last ']' so stray prose or code fences don't break parsing.
Blank entries are dropped and the result is capped at maxSuggestions.
*/
func parseSuggestions(raw string) []string {
	raw = strings.TrimSpace(raw)
	start := strings.Index(raw, "[")
	end := strings.LastIndex(raw, "]")
	if start == -1 || end == -1 || end <= start {
		return nil
	}
	var parsed []string
	if err := json.Unmarshal([]byte(raw[start:end+1]), &parsed); err != nil {
		return nil
	}
	out := make([]string, 0, len(parsed))
	for _, s := range parsed {
		s = strings.TrimSpace(s)
		if s == "" {
			continue
		}
		out = append(out, s)
		if len(out) >= maxSuggestions {
			break
		}
	}
	return out
}
