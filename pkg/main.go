package main

import (
	"os"

	"github.com/grafana/grafana-plugin-sdk-go/backend/app"
	"github.com/grafana/grafana-plugin-sdk-go/backend/log"

	pluginapp "github.com/grafana-mcp-agent/mcpagent/pkg/plugin"
)

func main() {
	if err := app.Manage("mcpagent-app", pluginapp.NewApp, app.ManageOpts{}); err != nil {
		log.DefaultLogger.Error("failed to manage plugin", "error", err)
		os.Exit(1)
	}
}
