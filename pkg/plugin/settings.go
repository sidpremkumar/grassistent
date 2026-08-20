package plugin

import (
	"encoding/json"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
)

// MCPServerConfig describes one configured MCP server the agent can call.
// Only HTTP / streamable-HTTP transports are supported (no local process spawn).
type MCPServerConfig struct {
	// Name is a short identifier surfaced in the UI (e.g. "skippy").
	Name string `json:"name"`
	// URL is the base MCP endpoint (e.g. https://skippy.internal/mcp).
	URL string `json:"url"`
	// HeaderName / secret key of an optional auth header. The value is stored in
	// secureJSONData under "mcpSecret_<Name>" so it is never sent to the browser.
	AuthHeader string `json:"authHeader,omitempty"`
}

// Settings is the plugin's non-secret configuration (jsonData).
type Settings struct {
	// BedrockRegion is the AWS region hosting the Bedrock model.
	BedrockRegion string `json:"bedrockRegion"`
	// ModelID is the Bedrock model identifier (e.g. an Anthropic Claude model ARN/ID).
	ModelID string `json:"modelId"`
	// MaxToolIterations caps the agent tool loop.
	MaxToolIterations int `json:"maxToolIterations"`
	// SystemPrompt is an optional operator-provided system prompt override.
	SystemPrompt string `json:"systemPrompt,omitempty"`
	// MCPServers is the list of MCP servers the agent may call.
	MCPServers []MCPServerConfig `json:"mcpServers"`
}

// secrets holds decrypted secureJSONData: AWS creds (optional; falls back to the
// default AWS credential chain) and per-MCP auth header values.
type secrets struct {
	awsAccessKeyID     string
	awsSecretAccessKey string
	awsSessionToken    string
	mcpAuthValues      map[string]string
}

func defaultSettings() Settings {
	return Settings{
		BedrockRegion:     "us-east-1",
		ModelID:           "anthropic.claude-3-5-sonnet-20241022-v2:0",
		MaxToolIterations: 12,
		MCPServers:        []MCPServerConfig{},
	}
}

// loadSettings parses jsonData + secureJSONData from the Grafana app instance
// settings, applying defaults for anything unset.
func loadSettings(appSettings backend.AppInstanceSettings) (Settings, secrets, error) {
	s := defaultSettings()
	if len(appSettings.JSONData) > 0 {
		if err := json.Unmarshal(appSettings.JSONData, &s); err != nil {
			return Settings{}, secrets{}, err
		}
	}
	if s.BedrockRegion == "" {
		s.BedrockRegion = defaultSettings().BedrockRegion
	}
	if s.ModelID == "" {
		s.ModelID = defaultSettings().ModelID
	}
	if s.MaxToolIterations <= 0 {
		s.MaxToolIterations = defaultSettings().MaxToolIterations
	}

	sec := secrets{mcpAuthValues: map[string]string{}}
	for k, v := range appSettings.DecryptedSecureJSONData {
		switch k {
		case "awsAccessKeyId":
			sec.awsAccessKeyID = v
		case "awsSecretAccessKey":
			sec.awsSecretAccessKey = v
		case "awsSessionToken":
			sec.awsSessionToken = v
		default:
			if len(k) > len("mcpSecret_") && k[:len("mcpSecret_")] == "mcpSecret_" {
				sec.mcpAuthValues[k[len("mcpSecret_"):]] = v
			}
		}
	}
	return s, sec, nil
}
