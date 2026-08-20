# 09 — Build & run (local dev-ex)

This is the day-to-day loop for building the plugin and iterating against a local
Grafana in Docker.

## Prerequisites

- Node ≥ 20 (repo tested on Node 22).
- Go 1.25.x (SDK pinned to v0.251.0 for this Go version).
- Docker (for local Grafana).
- AWS credentials with Bedrock access to the configured model. `aws-vault` (or
  any way to export creds into your shell) is assumed below.

## TL;DR loop

```bash
# 1. one-time: install deps + build the Go backend binaries
npm install
npm run backend:build                # `mage -v build:linux` -> dist/gpx_* (amd64 + arm64)
# (no mage installed? build directly with the go build commands below)

# 2. build the frontend
npm run build                        # -> dist/module.js, dist/plugin.json, ...

# 3. start Grafana with fresh AWS creds injected
aws-vault exec <profile> --no-session -- \
  bash -c 'export AWS_REGION=us-east-1; docker compose up -d'

# 4. enable the app (app plugins don't start their backend until enabled)
curl -s -u admin:admin -X POST \
  http://localhost:3001/api/plugins/mcpagent-app/settings \
  -H 'Content-Type: application/json' -d '{"enabled":true,"pinned":true}'

# open http://localhost:3001  (anonymous Admin in dev)
```

Iterating on the **frontend only**: re-run `npm run build` (or `npm run dev` for
watch mode) and hard-reload the browser (`Cmd/Ctrl+Shift+R`). `dist/` is
volume-mounted, so no container restart is needed.

Iterating on the **backend** (Go) or on **`plugin.json`**: rebuild the binary /
frontend, then restart Grafana (`docker compose restart`) so it reloads the
plugin process and manifest, then re-run the enable curl.

## Build the frontend

```bash
npm run build      # production build
npm run dev        # watch mode (dev build)
```

The npm `build`/`dev` scripts prefix webpack with
`TS_NODE_COMPILER_OPTIONS={"module":"commonjs"}` so webpack-cli can load the
TypeScript `webpack.config.ts`.

> Gotcha: the scripts invoke `cross-env`, which is **not** currently a
> dependency. If you hit `sh: cross-env: command not found`, run webpack
> directly (this is what CI/the maintainers use):
>
> ```bash
> TS_NODE_COMPILER_OPTIONS='{"module":"commonjs"}' \
>   ./node_modules/.bin/webpack -c ./webpack.config.ts --env production
> ```

`webpack.config.ts` sets `output.clean: { keep: /gpx_/ }` so a frontend build
does **not** delete the Go backend binaries already in `dist/`.

## Build the backend

```bash
GOOS=linux GOARCH=amd64 go build -o dist/gpx_mcpagent_linux_amd64 ./pkg
GOOS=linux GOARCH=arm64 go build -o dist/gpx_mcpagent_linux_arm64 ./pkg
```

Grafana selects `gpx_mcpagent_<os>_<arch>` matching the container. The Linux
images above cover both amd64 and arm64 hosts (Apple Silicon runs arm64). For a
native macOS run outside Docker, also build `darwin_arm64`.

Sanity checks:
```bash
./node_modules/.bin/tsc --noEmit     # frontend typecheck
go build ./... && go vet ./...       # backend
```

## Run local Grafana

`docker-compose.yaml` runs `grafana/grafana:13.2.0`, mounts `./dist` into the
container's plugin dir, mounts the provisioning files, and allows the unsigned
plugin. Grafana is exposed on host port **3001** (mapped to container 3000) to
avoid colliding with other local Grafana instances.

```bash
aws-vault exec <profile> --no-session -- \
  bash -c 'export AWS_REGION=us-east-1; docker compose up -d'
# Grafana: http://localhost:3001  (anonymous Admin in dev)
```

Key compose settings:
- `GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=mcpagent-app` — load the unsigned dev build.
- `GF_PLUGINS_FORWARD_HOST_ENV_VARS=mcpagent-app` — **required.** Since Grafana
  12.4, plugin subprocesses no longer inherit the host's env by default. Without
  this the backend can't see `AWS_*` and falls back to EC2 IMDS, failing with
  `no EC2 IMDS role found`.
- `GF_FEATURE_TOGGLES_ENABLE=singleTopNav,extensionSidebar` — enables the unified
  top bar. (The chat trigger is DOM-injected next to Search / Sign in; see
  [02-frontend.md](./02-frontend.md) for why extension slots can't be used.)
- `GF_DEFAULT_APP_MODE=development`
- `GF_AUTH_ANONYMOUS_ENABLED=true`, `GF_AUTH_ANONYMOUS_ORG_ROLE=Admin`
- `AWS_*` passed through so the backend's default credential chain works without
  putting static keys in the plugin config.

### Enable the app

An app plugin's backend does not start until the app is **enabled**. Either flip
it in **Administration → Plugins → MCP Agent** (toggle *Enable*), or POST:

```bash
curl -s -u admin:admin -X POST \
  http://localhost:3001/api/plugins/mcpagent-app/settings \
  -H 'Content-Type: application/json' -d '{"enabled":true,"pinned":true}'
```

Then set the model and MCP servers under **MCP Agent → Configuration**, and open
the chat from the **MCP Agent** button in the top bar (or the floating button
fallback). The chat is a **docked panel** that pushes the page content aside so
you can keep editing panels/queries while chatting.

## Provisioned datasources (for page-context + browser-tool testing)

`provisioning/` is mounted into the container and is part of the repo:

- `provisioning/datasources/mock.yaml` — **TestData** datasources
  (`mock-metrics`, `mock-logs`) plus **Local Prometheus** (`local-prom`),
  a real Prometheus from the compose stack (service `prometheus`, host port
  9091) that self-scrapes and scrapes Grafana — real metrics with zero seeding.
- `provisioning/prometheus/prometheus.yml` — its scrape config.
- `provisioning/dashboards/dashboards.yaml` + `provisioning/dashboards-json/` —
  sample dashboard(s) loaded on startup. `checkout.json` has two TestData
  panels (ids 1–2) and one **real PromQL panel** (id 3,
  `sum(rate(prometheus_http_requests_total[1m]))`) so live query-edit tools
  (`update_panel_query`, `open_explore`) have a genuine query language to act
  on. TestData panels have **no query language** — the agent will (correctly)
  refuse to "aggregate" them.

## Mock MCP server (for agent-loop testing)

To exercise the tool loop without a real MCP backend, run any minimal HTTP MCP
server implementing `initialize`, `tools/list`, `tools/call` (streamable-HTTP).
Configure it on the config page as
`{ name: "mock", url: "http://host.docker.internal:PORT/mcp" }`. From inside the
Grafana container, reach host services via `host.docker.internal`.

## Verify streaming end-to-end (no browser)

The backend streams Bedrock tokens as SSE. You can smoke-test it directly:

```bash
curl -s -N -u admin:admin -X POST \
  http://localhost:3001/api/plugins/mcpagent-app/resources/chat \
  -H 'Content-Type: application/json' \
  -d '{"sessionId":"t","message":"say hello in 3 words","history":[]}' --max-time 35
# expect: data: {"type":"content","text":"Hello"} ... data: {"type":"done"}
```

## Troubleshooting

- **`no EC2 IMDS role found` / credentials time out**: the plugin process isn't
  seeing your AWS creds. Ensure `GF_PLUGINS_FORWARD_HOST_ENV_VARS=mcpagent-app`
  is set *and* the creds were exported into the shell that ran `docker compose
  up`. Temporary STS creds expire — recreate the container with fresh creds
  (`docker compose up -d --force-recreate` inside a fresh `aws-vault exec`).
- **Chat button missing**: you may be on the pre-`singleTopNav` two-level top bar
  (button falls back to a floating action button). Confirm the feature toggle,
  hard-reload, and check the browser console.
- **Plugin not visible**: confirm `dist/` contains `module.js`, `plugin.json`,
  and a matching `gpx_mcpagent_<os>_<arch>`; check the unsigned allowlist env.
- **Backend won't start**: check Grafana server logs (`docker logs
  grafana-mcp-agent-grafana-1`); ensure the binary arch matches the container.
- **Bedrock model errors**: verify region, model id, and IAM permission on the
  model; retired model ids return `ResourceNotFoundException` — pick a current
  inference-profile id (e.g. `us.anthropic.claude-sonnet-4-5-...`).
- **MCP init fails**: verify the URL is reachable from the Grafana container and
  returns JSON-RPC (or SSE) for `initialize`.
```
