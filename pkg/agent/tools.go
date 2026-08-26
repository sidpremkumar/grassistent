package agent

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
)

/*
 * Tool-name hygiene.
 *
 * Two distinct failure modes live here, both observed in production against a
 * large MCP server:
 *
 *  1. The model calls a tool that does not exist. This is not (only) a
 *     hallucination: operator context injected into the system prompt is often
 *     written for a DIFFERENT agent whose tool names carry another prefix (e.g.
 *     docs that say "grafana_query_prometheus" while this server advertises
 *     "query_prometheus", which we namespace to "<server>__query_prometheus").
 *     The model then composes "<server>__grafana_query_prometheus". The old
 *     error — `unknown tool "x"` — gave it nothing to correct with, so it
 *     retried variations of the same wrong name until the iteration budget ran
 *     out. suggestTools() turns that dead end into a self-correcting hint.
 *
 *  2. The model emits a tool name Bedrock itself will not accept. Names must
 *     match ^[a-zA-Z0-9_-]{1,64}$. A malformed name (we have seen the literal
 *     "$PARAMETER_NAME") is harmless on the way out, but the loop echoes the
 *     assistant message back on the next iteration — and Bedrock validates
 *     toolUse names on input, so the whole turn dies with an opaque
 *     `ConverseStream ... StatusCode: 400` AFTER the user has already seen
 *     partial output. sanitizeToolName() keeps the echo legal so the turn ends
 *     with a readable "unknown tool" result instead.
 */

// bedrockToolNamePattern is Bedrock's accepted tool-name shape, applied both to
// the tool specs we advertise and to tool names the model sends back.
var bedrockToolNamePattern = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,64}$`)

func validToolName(name string) bool { return bedrockToolNamePattern.MatchString(name) }

// sanitizeToolName rewrites a model-emitted tool name into something Bedrock
// will accept on the next request. Illegal characters become "_" and the result
// is truncated to 64 chars; an empty name becomes "unknown_tool". The value is
// only ever used for the echo and for lookup (which will miss, producing an
// unknown-tool result) — never to invoke anything.
func sanitizeToolName(name string) string {
	if validToolName(name) {
		return name
	}
	var b strings.Builder
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '_', r == '-':
			b.WriteRune(r)
		default:
			b.WriteRune('_')
		}
	}
	cleaned := b.String()
	if len(cleaned) > 64 {
		cleaned = cleaned[:64]
	}
	if cleaned == "" {
		return "unknown_tool"
	}
	return cleaned
}

// maxToolSuggestions bounds the hint fed back to the model: enough to recover
// from a wrong prefix, small enough not to dominate the context window.
const maxToolSuggestions = 12

// suggestTools ranks the available tool names by their similarity to what the
// model asked for. The dominant real-world error is a wrong prefix or namespace,
// so scoring is deliberately substring-oriented rather than edit-distance based:
// "skippy__grafana_list_alert_rules" must surface "skippy__list_alert_rules".
func suggestTools(wanted string, available []string) []string {
	needle := strings.ToLower(wanted)
	/* Compare on the bare tool name too, so a wrong server namespace still
	 * matches. */
	bare := needle
	if i := strings.Index(bare, "__"); i >= 0 {
		bare = bare[i+2:]
	}
	segments := strings.FieldsFunc(bare, func(r rune) bool { return r == '_' || r == '-' })

	type scored struct {
		name  string
		score int
	}
	var ranked []scored
	for _, candidate := range available {
		lower := strings.ToLower(candidate)
		candidateBare := lower
		if i := strings.Index(candidateBare, "__"); i >= 0 {
			candidateBare = candidateBare[i+2:]
		}

		score := 0
		switch {
		case candidateBare == bare:
			score += 100
		case strings.HasSuffix(candidateBare, bare) || strings.HasSuffix(bare, candidateBare):
			/* Exactly the wrong-prefix case: "grafana_list_alert_rules" vs
			 * "list_alert_rules". */
			score += 60
		case strings.Contains(candidateBare, bare) || strings.Contains(bare, candidateBare):
			score += 40
		}
		for _, seg := range segments {
			if len(seg) > 2 && strings.Contains(candidateBare, seg) {
				score += 4
			}
		}
		if score > 0 {
			ranked = append(ranked, scored{name: candidate, score: score})
		}
	}

	sort.SliceStable(ranked, func(i, j int) bool {
		if ranked[i].score != ranked[j].score {
			return ranked[i].score > ranked[j].score
		}
		return ranked[i].name < ranked[j].name
	})

	out := make([]string, 0, maxToolSuggestions)
	for _, r := range ranked {
		if len(out) == maxToolSuggestions {
			break
		}
		out = append(out, r.name)
	}
	return out
}

// unknownToolMessage is the tool result returned when the model calls a name we
// cannot dispatch. It states the constraint (exact names only), offers the
// closest real names, and — when nothing looks close — says how many tools exist
// so the model stops guessing and asks the user instead.
func unknownToolMessage(wanted string, available []string) string {
	suggestions := suggestTools(wanted, available)
	var b strings.Builder
	fmt.Fprintf(&b, "unknown tool %q: no such tool is available to you.", wanted)
	if len(suggestions) > 0 {
		fmt.Fprintf(&b, "\n\nDid you mean one of these? Use the name EXACTLY as written:\n")
		for _, s := range suggestions {
			fmt.Fprintf(&b, "  - %s\n", s)
		}
		b.WriteString(
			"\nTool names are always \"<server>__<tool>\" as advertised in your tool list. " +
				"Any other name you have read in documentation or operator notes is NOT callable here — " +
				"map it onto one of the names above.")
	} else {
		fmt.Fprintf(&b,
			"\n\nNothing in your %d available tools resembles that name. "+
				"Do not guess further variations: either use a tool that IS in your list, or tell the "+
				"user this capability is not available to you.", len(available))
	}
	return strings.TrimSpace(b.String())
}
