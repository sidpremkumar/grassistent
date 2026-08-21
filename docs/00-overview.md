# 00 — Overview

## What it is

A Grafana **app plugin** (`type: app`, id `mcpagent-app`) that adds an AI chat agent to Grafana. The agent:

1. Reads the current Grafana page context (dashboard/panel/alert/time range) in the browser.
2. Offers a context-derived suggested question as a tappable chip (input is never pre-seeded).
3. On send, streams the turn to the plugin's **Go backend**, which runs an agent loop on **AWS Bedrock** (ConverseStream API, token streaming).
4. The loop calls tools exposed by one or more **HTTP MCP servers** the operator configured, and streams reasoning/tool-calls/answer back to the browser as Server-Sent Events.
5. The loop can also **act on the live page** via frontend-executed browser tools (time range, variables, Explore, live panel-query edits) using a pause/continue protocol — see [11](./11-browser-tools.md).

It is deliberately generic: it has **no knowledge of any specific MCP backend**. Point it at any HTTP MCP endpoint(s).

## Component map

```
src/                          # Frontend (React 19 + @grafana/ui 13)
  module.tsx                  # Plugin registration (root page, config page) + mounts the
                              #   global FloatingChat into <body> (plugin is preloaded)
  pages/
    App.tsx                   # App root -> renders AppPage
    AppPage.tsx               # Full-page chat route (nav "MCP Agent")
    ConfigPage.tsx            # Admin config (Bedrock, AWS creds, MCP servers)
  components/
    FloatingChat.tsx          # Global entry: injects the top-bar trigger + renders the
                              #   docked chat panel that pushes the page aside
    ChatPanel.tsx             # The chat surface (history list, messages, tool trace,
                              #   typewriter answer, input, animations)
    use-agent-chat.ts         # Hook: conversation state + SSE lifecycle
    ThinkingBlock.tsx         # Collapsible Linear/Cursor-style "thinking" trace
    JsonBlock.tsx             # Collapsible, syntax-highlighted JSON viewer for tool
                              #   input/output payloads (copy-to-clipboard)
  lib/
    protocol.ts               # ChatRequest / AgentEvent / PageContext types + SSE parse
    chat-stream.ts            # POST /resources/chat and parse SSE stream
    chat-store.ts             # localStorage-backed session persistence + titles
    page-context.ts           # extractPageContext() (async) + buildPrefill()
    motion.ts                 # framer-motion variants / springs
  plugin.json                 # Plugin manifest (preload: true)
  img/logo.svg

pkg/                          # Backend (Go)
  main.go                     # app.Manage("mcpagent-app", NewApp, ...)
  plugin/
    app.go                    # App instance: builds Bedrock + MCP clients from settings
    resources.go              # HTTP mux; /chat SSE handler; page-context prompt enrichment
    settings.go               # Settings + secrets parsing from AppInstanceSettings + env
  mcp/
    client.go                 # MCP JSON-RPC-over-HTTP client (initialize/tools.list/tools.call)
  agent/
    agent.go                  # Bedrock ConverseStream tool-use loop; emits Event
    helpers.go                # message building, document<->JSON, previews
```

> UI placement note: Grafana 13 gates every top-bar / extension-sidebar
> extension slot to an internal plugin allow-list, so a third-party plugin can't
> render "next to Sign in" via extension points. The plugin is `preload: true`,
> so `module.tsx` runs on every page and `FloatingChat` (a) DOM-injects a trigger
> button beside Search/Sign in and (b) renders the chat as a docked panel that
> shrinks `.grafana-app` rather than overlaying it, keeping the page interactive.

## Request lifecycle (one chat turn)

```
User types / accepts prefill in ChatPanel
  -> useAgentChat.send(text, pageContext)
    -> streamChat() POST /api/plugins/mcpagent-app/resources/chat  (same-origin, Grafana session auth)
      -> [Go] resources.handleChat: decode ChatRequest, enrichWithContext()
        -> App.newAgent().Run(ctx, message, history, emit)
          -> agent.collectTools(): for each MCP client: Initialize + ListTools -> Bedrock ToolConfig
          -> loop (<= MaxToolIterations):
               bedrock.ConverseStream(messages, system, toolConfig)
               emit content deltas as SSE in real time (typewriter)
               if StopReason == tool_use: for each tool_use -> mcp.CallTool -> toolResult -> next turn
               else: emit {type:"done"} and return
      <- SSE frames: data: {AgentEvent}\n\n  (content, reasoning, tool_call, tool_result, status, done, error)
  <- useAgentChat patches ChatMessage state; ChatPanel re-renders with animation
```

## Current-state matrix

| Capability | State | Notes |
| --- | --- | --- |
| Frontend chat UI + animations | ✅ built | `ChatPanel.tsx`, typechecks clean |
| Docked panel (pushes page, not overlay) | ✅ built | `FloatingChat.tsx` shrinks `.grafana-app`; page stays interactive |
| Top-bar trigger next to Sign in | ✅ built (DOM-injected) | extension slots are allow-listed, so injected via MutationObserver; FAB fallback |
| Chat history (localStorage) | ✅ built | `chat-store.ts`; session list + resume + delete |
| Page-context extraction + suggestion chip | ✅ built (best-effort) | async; mount retry + URL-change re-extract; chip, never pre-seeded input; see [06](./06-page-context.md) |
| Browser tools (live UI agency) | ✅ built + verified | pause/continue loop, Tier 1 URL-state + Tier 2 scene mutation, `ask_user`; see [11](./11-browser-tools.md) |
| Confirmation gate for mutating tools | ✅ built | Allow / Always allow / Deny chips; `update_panel_query` gated |
| SSE token streaming (typewriter) | ✅ built + verified | `ConverseStream` deltas ↔ `chat-stream.ts`; blinking caret while streaming |
| MCP HTTP client | ✅ built | `mcp/client.go`; HTTP + SSE responses |
| Bedrock ConverseStream agent loop | ✅ built | `agent/agent.go` |
| Config page (Bedrock/AWS/MCP) | ✅ built | `ConfigPage.tsx` writes jsonData/secureJsonData |
| Env-var config (headless) | ✅ built | `settings.go` layers UI > env > defaults; needs `forward_host_env_vars` |
| Frontend build (webpack) | ✅ working | needs `TS_NODE_COMPILER_OPTIONS={"module":"commonjs"}`; `cross-env` not installed (run webpack directly) |
| Go backend build | ✅ working | `go build ./pkg`; SDK pinned v0.251.0 |
| Local run (docker-compose + unsigned) | ✅ verified | Grafana 13.2; requires `GF_PLUGINS_FORWARD_HOST_ENV_VARS` for AWS creds |
| Mock datasource / dashboard | ✅ in repo | `provisioning/`; mock MCP still external |
| `list_tools` / tool-permission UI | ⚠️ partial | browser mutating tools are confirm-gated; MCP tools are not gated (caps only) |
| Reasoning stream (`reasoning` events) | ⚠️ partial | type exists; backend does not emit separate reasoning (ConverseStream text only) |
| Signing / distribution | ❌ not done | dev runs unsigned via env allowlist |

See [10-roadmap.md](./10-roadmap.md) for the authoritative gap list.
