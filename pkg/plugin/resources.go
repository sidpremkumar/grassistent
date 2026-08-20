package plugin

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/backend/resource/httpadapter"

	"github.com/grafana-mcp-agent/mcpagent/pkg/agent"
)

// pageContext mirrors the frontend PageContext.
type pageContext struct {
	Summary        string   `json:"summary"`
	DashboardTitle string   `json:"dashboardTitle"`
	DashboardUID   string   `json:"dashboardUid"`
	PanelTitle     string   `json:"panelTitle"`
	Queries        []string `json:"queries"`
	Datasource     string   `json:"datasource"`
	URL            string   `json:"url"`
	TimeRange      *struct {
		From string `json:"from"`
		To   string `json:"to"`
	} `json:"timeRange"`
}

type chatRequest struct {
	SessionID   string       `json:"sessionId"`
	Message     string       `json:"message"`
	History     []agent.Turn `json:"history"`
	PageContext *pageContext `json:"pageContext"`
	// BrowserTools advertises tools the frontend can execute in the page.
	BrowserTools []agent.BrowserToolSpec `json:"browserTools"`
	// Continuation + ToolResults resume a turn paused on browser tool calls;
	// when set, Message is ignored.
	Continuation string                    `json:"continuation"`
	ToolResults  []agent.BrowserToolResult `json:"toolResults"`
}

// newResourceHandler builds the HTTP mux for plugin resource routes.
func newResourceHandler(app *App) backend.CallResourceHandler {
	mux := http.NewServeMux()
	mux.HandleFunc("/chat", app.handleChat)
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	return httpadapter.New(mux)
}

// handleChat runs one agent turn and streams AgentEvents as SSE.
func (a *App) handleChat(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req chatRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}
	if strings.TrimSpace(req.Message) == "" && strings.TrimSpace(req.Continuation) == "" {
		http.Error(w, "message is required", http.StatusBadRequest)
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	emit := func(ev agent.Event) {
		payload, err := json.Marshal(ev)
		if err != nil {
			return
		}
		_, _ = fmt.Fprintf(w, "data: %s\n\n", payload)
		flusher.Flush()
	}

	ctx := r.Context()
	if strings.TrimSpace(req.Continuation) != "" {
		/* Resume a paused turn: the frontend executed browser tools and sends
		 * their results plus the page context observed after the actions. */
		contextText := ""
		if req.PageContext != nil {
			contextText = "[Grafana page context observed after the browser actions]\n" + contextBody(req.PageContext)
		}
		if err := a.newAgent().Continue(ctx, req.Continuation, req.ToolResults, req.BrowserTools, contextText, emit); err != nil {
			backend.Logger.Error("agent continue failed", "error", err)
		}
		return
	}

	message := enrichWithContext(req.Message, req.PageContext)
	if err := a.newAgent().Run(ctx, message, req.History, req.BrowserTools, emit); err != nil {
		backend.Logger.Error("agent run failed", "error", err)
		/* Run already emitted an error event; nothing else to send. */
	}
}

// enrichWithContext prepends a compact page-context preamble so the agent knows
// what the user is looking at without the frontend hard-coding provider prompts.
func enrichWithContext(message string, ctx *pageContext) string {
	if ctx == nil {
		return message
	}
	var b strings.Builder
	b.WriteString("[Grafana page context]\n")
	b.WriteString(contextBody(ctx))
	b.WriteString("\n[User question]\n")
	b.WriteString(message)
	return b.String()
}

// contextBody renders the page context fields shared by initial and
// post-action (continuation) prompts.
func contextBody(ctx *pageContext) string {
	var b strings.Builder
	if ctx.Summary != "" {
		b.WriteString(ctx.Summary)
		b.WriteString("\n")
	}
	if ctx.DashboardTitle != "" {
		fmt.Fprintf(&b, "Dashboard: %s\n", ctx.DashboardTitle)
	}
	if ctx.PanelTitle != "" {
		fmt.Fprintf(&b, "Panel: %s\n", ctx.PanelTitle)
	}
	if ctx.Datasource != "" {
		fmt.Fprintf(&b, "Datasource: %s\n", ctx.Datasource)
	}
	for _, q := range ctx.Queries {
		fmt.Fprintf(&b, "Query: %s\n", q)
	}
	if ctx.TimeRange != nil {
		fmt.Fprintf(&b, "Time range: %s to %s\n", ctx.TimeRange.From, ctx.TimeRange.To)
	}
	if ctx.URL != "" {
		fmt.Fprintf(&b, "URL: %s\n", ctx.URL)
	}
	return b.String()
}
