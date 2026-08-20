# Grafana MCP Agent

An open-source Grafana **app plugin** that adds an AI chat agent to Grafana. The agent connects to any [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server(s) you configure and can call their tools to investigate. When you open the chat, it **auto-prefills your question from the page you're viewing** — the dashboard, panel query, time range, or alert.

It is intentionally generic: it does not know about any specific backend. Point it at one or more HTTP MCP servers and it rides on top of them.

## How it works

```
┌──────────────────────────┐        ┌────────────────────────────┐
│ Grafana (browser)        │        │ Plugin backend (Go)        │
│                          │  SSE   │                            │
│  Chat UI (React +        │◀──────▶│  Agent loop:               │
│  framer-motion)          │  POST  │   AWS Bedrock (Converse)   │
│  + page-context prefill  │        │   ↕ MCP tools (HTTP)       │
└──────────────────────────┘        └──────────────┬─────────────┘
                                                    │ streamable-HTTP
                                     ┌──────────────▼─────────────┐
                                     │ MCP server(s) you configure│
                                     │ (e.g. .../mcp)             │
                                     └────────────────────────────┘
```

- **Frontend** (`src/`): React chat UI. Reads Grafana page context (`src/lib/page-context.ts`) and streams agent events over SSE (`src/lib/chat-stream.ts`). All animation is via framer-motion (`src/lib/motion.ts`) and respects reduced-motion.
- **Backend** (`pkg/`): A Grafana plugin backend in Go. Runs the agent loop against **AWS Bedrock** (Converse API) with tools sourced from your configured MCP servers (`pkg/mcp/client.go`, `pkg/agent/agent.go`). Streams `AgentEvent`s back as SSE.

The model runs server-side, so **no API keys or MCP secrets are ever exposed to the browser**. The frontend only talks to the plugin's same-origin resource route (`/api/plugins/mcpagent-app/resources/chat`), authenticated by the user's Grafana session.

## Configuration

Open the plugin's **Configuration** page (admin) to set:

- **Bedrock**: region, model ID (e.g. a Claude model), max tool iterations, optional system prompt.
- **AWS credentials** (optional): leave blank to use the default AWS credential chain (IRSA, instance role, env). Static keys are stored as secrets.
- **MCP servers**: a list of `{ name, url, authHeader }`. The auth header *value* is stored as a secret (`mcpSecret_<name>`). Only HTTP / streamable-HTTP transports are supported.

## Develop

Requires Node ≥ 20 and Go ≥ 1.22.

```bash
# Frontend
npm install
npm run dev          # watch build into dist/

# Backend (Go plugin binary into dist/)
go run mage.go       # or: npm run backend:build

# Run Grafana locally with the plugin mounted (unsigned)
docker compose up
# Grafana at http://localhost:3000 (anonymous admin in dev)
```

The plugin loads unsigned in development via `GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=mcpagent-app`.

## Page-context prefill

`extractPageContext()` reads officially-supported Grafana runtime APIs (`getTemplateSrv`, `locationService`) plus best-effort dashboard/panel/alert hints from the URL and scene context. `buildPrefill()` turns that into a suggested question, and the same context is sent to the backend so the agent knows what you're looking at. Everything is optional — no context still gives you a plain chat.

## License

Apache-2.0.
