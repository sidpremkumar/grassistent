package plugin

import (
	"encoding/json"
	"os"
	"strconv"
	"strings"

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
	// MaxTools caps how many MCP tools are advertised to the model (0 = no cap).
	// Large MCP servers can expose hundreds of tools, overflowing the model's
	// context; this bounds that.
	MaxTools int `json:"maxTools"`
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
		ModelID:           "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
		MaxToolIterations: 12,
		MaxTools:          64,
		MCPServers:        []MCPServerConfig{},
	}
}

// Env var names for headless configuration. UI-provided settings take
// precedence; anything unset falls back to these, then to defaults.
const (
	envBedrockRegion     = "MCPAGENT_BEDROCK_REGION"
	envModelID           = "MCPAGENT_MODEL_ID"
	envMaxToolIterations = "MCPAGENT_MAX_TOOL_ITERATIONS"
	envMaxTools          = "MCPAGENT_MAX_TOOLS"
	envSystemPrompt      = "MCPAGENT_SYSTEM_PROMPT"
	// envMCPServers is a JSON array of MCPServerConfig, e.g.
	// [{"name":"skippy","url":"https://host/mcp","authHeader":"Authorization"}]
	envMCPServers = "MCPAGENT_MCP_SERVERS"
	// Per-server auth header value: MCPAGENT_MCP_SECRET_<NAME> (name upper-cased).
	envMCPSecretPrefix = "MCPAGENT_MCP_SECRET_"
	// Standard AWS env vars are honored by the AWS SDK directly; these mirror
	// them so operators can set creds specifically for this plugin.
	envAWSAccessKeyID     = "AWS_ACCESS_KEY_ID"
	envAWSSecretAccessKey = "AWS_SECRET_ACCESS_KEY"
	envAWSSessionToken    = "AWS_SESSION_TOKEN"
	envAWSRegion          = "AWS_REGION"
)

// loadSettings resolves configuration by layering, in order of precedence:
//  1. UI jsonData / secureJSONData (highest)
//  2. environment variables
//  3. built-in defaults
func loadSettings(appSettings backend.AppInstanceSettings) (Settings, secrets, error) {
	s := defaultSettings()
	if len(appSettings.JSONData) > 0 {
		if err := json.Unmarshal(appSettings.JSONData, &s); err != nil {
			return Settings{}, secrets{}, err
		}
	}

	applyEnvSettings(&s)

	if s.BedrockRegion == "" {
		s.BedrockRegion = defaultSettings().BedrockRegion
	}
	if s.ModelID == "" {
		s.ModelID = defaultSettings().ModelID
	}
	if s.MaxToolIterations <= 0 {
		s.MaxToolIterations = defaultSettings().MaxToolIterations
	}
	if s.MaxTools < 0 {
		s.MaxTools = 0
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
			if strings.HasPrefix(k, "mcpSecret_") {
				sec.mcpAuthValues[strings.TrimPrefix(k, "mcpSecret_")] = v
			}
		}
	}

	applyEnvSecrets(&sec, s.MCPServers)

	return s, sec, nil
}

// applyEnvSettings fills any unset non-secret field from environment variables.
// Env values only apply when the corresponding UI value is empty/zero so the UI
// keeps precedence.
func applyEnvSettings(s *Settings) {
	if s.BedrockRegion == "" {
		if v := firstEnv(envBedrockRegion, envAWSRegion); v != "" {
			s.BedrockRegion = v
		}
	}
	if s.ModelID == "" {
		if v := os.Getenv(envModelID); v != "" {
			s.ModelID = v
		}
	}
	if s.MaxToolIterations <= 0 {
		if n, ok := envInt(envMaxToolIterations); ok {
			s.MaxToolIterations = n
		}
	}
	if s.MaxTools == 0 {
		if n, ok := envInt(envMaxTools); ok {
			s.MaxTools = n
		}
	}
	if s.SystemPrompt == "" {
		if v := os.Getenv(envSystemPrompt); v != "" {
			s.SystemPrompt = v
		}
	}
	if len(s.MCPServers) == 0 {
		if raw := os.Getenv(envMCPServers); raw != "" {
			var servers []MCPServerConfig
			if err := json.Unmarshal([]byte(raw), &servers); err == nil {
				s.MCPServers = servers
			} else {
				backend.Logger.Warn("invalid "+envMCPServers+" JSON", "error", err)
			}
		}
	}
}

// applyEnvSecrets fills AWS creds and per-MCP auth values from env when not
// already provided via secureJSONData.
func applyEnvSecrets(sec *secrets, servers []MCPServerConfig) {
	if sec.awsAccessKeyID == "" {
		sec.awsAccessKeyID = os.Getenv(envAWSAccessKeyID)
	}
	if sec.awsSecretAccessKey == "" {
		sec.awsSecretAccessKey = os.Getenv(envAWSSecretAccessKey)
	}
	if sec.awsSessionToken == "" {
		sec.awsSessionToken = os.Getenv(envAWSSessionToken)
	}
	for _, srv := range servers {
		if srv.Name == "" {
			continue
		}
		if _, ok := sec.mcpAuthValues[srv.Name]; ok {
			continue
		}
		envName := envMCPSecretPrefix + strings.ToUpper(srv.Name)
		if v := os.Getenv(envName); v != "" {
			sec.mcpAuthValues[srv.Name] = v
		}
	}
}

// firstEnv returns the first non-empty value among the given env var names.
func firstEnv(names ...string) string {
	for _, n := range names {
		if v := os.Getenv(n); v != "" {
			return v
		}
	}
	return ""
}

// envInt parses an integer env var; ok is false when unset or invalid.
func envInt(name string) (int, bool) {
	v := os.Getenv(name)
	if v == "" {
		return 0, false
	}
	n, err := strconv.Atoi(strings.TrimSpace(v))
	if err != nil {
		return 0, false
	}
	return n, true
}
