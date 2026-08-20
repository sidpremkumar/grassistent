# grassistent docs

> Audience note: these docs are written primarily to be consumed by LLMs / coding agents. They favor precision, exact file paths, type signatures, and explicit "current state vs. not-yet-built" markers over prose. Keep them updated when code changes.

**grassistent** (package `grafana-mcp-agent`, plugin id `mcpagent-app`) is an open-source Grafana **app plugin**: an AI chat agent that connects to any HTTP MCP server(s) and auto-prefills questions from the Grafana page the user is viewing. The model loop runs in the plugin's Go backend against **AWS Bedrock**.

## Doc index

| Page | Contents |
| --- | --- |
| [00-overview.md](./00-overview.md) | What it is, component map, request lifecycle, current-state matrix |
| [01-architecture.md](./01-architecture.md) | Process/topology, trust boundary, data flow, why Go backend |
| [02-frontend.md](./02-frontend.md) | React modules, `module.tsx` registration, FloatingChat (docked panel + top-bar injection), history, chat state machine, animation system |
| [03-backend.md](./03-backend.md) | Go packages, app instance lifecycle, SSE `/chat` handler, settings/secrets |
| [04-mcp-client.md](./04-mcp-client.md) | MCP JSON-RPC-over-HTTP client, handshake, tool namespacing |
| [05-agent-loop.md](./05-agent-loop.md) | Bedrock ConverseStream tool-use loop, event emission, iteration/tool caps |
| [06-page-context.md](./06-page-context.md) | Async page-context extraction (dashboard API) + prefill, prompt enrichment |
| [07-protocol.md](./07-protocol.md) | Wire contracts: `ChatRequest`, `AgentEvent`, SSE framing |
| [08-config.md](./08-config.md) | `Settings`/secrets shape, UI>env>defaults precedence, config page |
| [09-build-and-run.md](./09-build-and-run.md) | Dev-ex loop: build frontend + Go backend, run local Grafana 13.2, env forwarding, provisioning |
| [10-roadmap.md](./10-roadmap.md) | Known gaps, not-yet-implemented, planned work |
| [11-browser-tools.md](./11-browser-tools.md) | Live UI agency: browser-executed tools, pause/continue loop, confirmation gate |

## Quick facts

- **Repo layout**: frontend in `src/` (TypeScript/React), backend in `pkg/` (Go), plugin manifest in `src/plugin.json` (`preload: true`).
- **Frontend deps (latest majors)**: React 19, `@grafana/{data,runtime,ui}` 13, framer-motion 11, webpack 5, swc, TypeScript 5.9.
- **Backend deps**: `grafana-plugin-sdk-go` v0.251.0 (pinned; newer requires Go ≥1.26, local is 1.25), `aws-sdk-go-v2` + `bedrockruntime`.
- **Transports supported**: MCP over HTTP / streamable-HTTP only. No stdio, no local process spawning.
- **Model**: AWS Bedrock via **ConverseStream** (token streaming). Default model id `us.anthropic.claude-sonnet-4-5-20250929-v1:0`.
- **UI**: docked right-side panel that pushes page content aside (not an overlay); localStorage chat history; DOM-injected top-bar trigger.
- **Local run**: `grafana/grafana:13.2.0` on `http://localhost:3001`; requires `GF_PLUGINS_FORWARD_HOST_ENV_VARS=mcpagent-app` for AWS creds.
- **License**: Apache-2.0.
