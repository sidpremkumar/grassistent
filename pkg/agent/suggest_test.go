package agent

import (
	"reflect"
	"testing"
)

func TestParseSuggestions(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want []string
	}{
		{
			name: "clean json array",
			raw:  `["Break down p99 by route","Compare error rate to last week"]`,
			want: []string{"Break down p99 by route", "Compare error rate to last week"},
		},
		{
			name: "wrapped in prose and fences",
			raw:  "Here you go:\n```json\n[\"a\", \"b\"]\n```",
			want: []string{"a", "b"},
		},
		{
			name: "drops blanks and trims",
			raw:  `["  keep  ", "", "   "]`,
			want: []string{"keep"},
		},
		{
			name: "caps at maxSuggestions",
			raw:  `["1","2","3","4","5","6"]`,
			want: []string{"1", "2"},
		},
		{
			name: "empty array yields nil",
			raw:  `[]`,
			want: nil,
		},
		{
			name: "no array yields nil",
			raw:  "sorry, I can't help with that",
			want: nil,
		},
		{
			name: "malformed json yields nil",
			raw:  `["unterminated`,
			want: nil,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := parseSuggestions(tc.raw)
			if len(got) == 0 && len(tc.want) == 0 {
				return
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("parseSuggestions(%q) = %#v, want %#v", tc.raw, got, tc.want)
			}
		})
	}
}
