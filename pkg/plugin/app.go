package plugin

import (
	"context"
	"net/http"
	"time"

	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/bedrockruntime"
	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/backend/instancemgmt"

	"github.com/grafana-mcp-agent/mcpagent/pkg/agent"
	"github.com/grafana-mcp-agent/mcpagent/pkg/mcp"
)

// App is the plugin app instance; holds resolved settings and clients.
type App struct {
	backend.CallResourceHandler
	settings Settings
	secrets  secrets
	bedrock  *bedrockruntime.Client
	http     *http.Client
}

// NewApp is the instance factory registered with the SDK.
func NewApp(ctx context.Context, appSettings backend.AppInstanceSettings) (instancemgmt.Instance, error) {
	settings, sec, err := loadSettings(appSettings)
	if err != nil {
		return nil, err
	}

	awsOpts := []func(*awsconfig.LoadOptions) error{
		awsconfig.WithRegion(settings.BedrockRegion),
	}
	if sec.awsAccessKeyID != "" && sec.awsSecretAccessKey != "" {
		awsOpts = append(awsOpts, awsconfig.WithCredentialsProvider(
			credentials.NewStaticCredentialsProvider(sec.awsAccessKeyID, sec.awsSecretAccessKey, sec.awsSessionToken),
		))
	}
	cfg, err := awsconfig.LoadDefaultConfig(ctx, awsOpts...)
	if err != nil {
		return nil, err
	}

	app := &App{
		settings: settings,
		secrets:  sec,
		bedrock:  bedrockruntime.NewFromConfig(cfg),
		http:     &http.Client{Timeout: 60 * time.Second},
	}
	app.CallResourceHandler = newResourceHandler(app)
	return app, nil
}

// Dispose satisfies instancemgmt.InstanceDisposer.
func (a *App) Dispose() {}

// buildClients constructs MCP clients from configured servers, injecting the
// per-server auth header value from decrypted secrets.
func (a *App) buildClients() []*mcp.Client {
	clients := make([]*mcp.Client, 0, len(a.settings.MCPServers))
	for _, s := range a.settings.MCPServers {
		authValue := a.secrets.mcpAuthValues[s.Name]
		clients = append(clients, mcp.NewClient(s.Name, s.URL, s.AuthHeader, authValue, a.http))
	}
	return clients
}

// newAgent wires the Bedrock client + MCP clients into an agent.
func (a *App) newAgent() *agent.Agent {
	systemPrompt := a.settings.SystemPrompt
	if systemPrompt == "" {
		systemPrompt = agent.DefaultSystemPrompt
	}
	return agent.New(a.bedrock, a.settings.ModelID, systemPrompt, a.settings.MaxToolIterations, a.settings.MaxTools, a.buildClients())
}
