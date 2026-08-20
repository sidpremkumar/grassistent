package mcp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
)

// Client is a minimal MCP client over the streamable-HTTP transport.
//
// It implements just enough of the spec for an agent: initialize, tools/list,
// and tools/call. Responses may come back as a single JSON object or as an SSE
// stream (Content-Type text/event-stream); both are handled.
type Client struct {
	name       string
	endpoint   string
	httpClient *http.Client
	authHeader string
	authValue  string
	sessionID  string
	nextID     int64
}

// Tool is a tool advertised by an MCP server.
type Tool struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	InputSchema json.RawMessage `json:"inputSchema"`
}

// NewClient builds an MCP client. authHeader/authValue are optional.
func NewClient(name, endpoint, authHeader, authValue string, httpClient *http.Client) *Client {
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	return &Client{
		name:       name,
		endpoint:   endpoint,
		httpClient: httpClient,
		authHeader: authHeader,
		authValue:  authValue,
	}
}

// Name returns the configured server name.
func (c *Client) Name() string { return c.name }

type rpcRequest struct {
	JSONRPC string      `json:"jsonrpc"`
	ID      int64       `json:"id,omitempty"`
	Method  string      `json:"method"`
	Params  interface{} `json:"params,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      int64           `json:"id"`
	Result  json.RawMessage `json:"result"`
	Error   *rpcError       `json:"error"`
}

func (c *Client) call(ctx context.Context, method string, params interface{}) (json.RawMessage, error) {
	id := atomic.AddInt64(&c.nextID, 1)
	body, err := json.Marshal(rpcRequest{JSONRPC: "2.0", ID: id, Method: method, Params: params})
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	if c.authHeader != "" && c.authValue != "" {
		req.Header.Set(c.authHeader, c.authValue)
	}
	if c.sessionID != "" {
		req.Header.Set("Mcp-Session-Id", c.sessionID)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if sid := resp.Header.Get("Mcp-Session-Id"); sid != "" {
		c.sessionID = sid
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return nil, fmt.Errorf("mcp %q %s: http %d: %s", c.name, method, resp.StatusCode, strings.TrimSpace(string(snippet)))
	}

	raw, err := readRPCResult(resp)
	if err != nil {
		return nil, err
	}
	var parsed rpcResponse
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, fmt.Errorf("mcp %q %s: decode: %w", c.name, method, err)
	}
	if parsed.Error != nil {
		return nil, fmt.Errorf("mcp %q %s: rpc error %d: %s", c.name, method, parsed.Error.Code, parsed.Error.Message)
	}
	return parsed.Result, nil
}

// readRPCResult reads either a plain JSON body or the final data frame of an
// SSE stream and returns the raw JSON-RPC response bytes.
func readRPCResult(resp *http.Response) ([]byte, error) {
	ct := resp.Header.Get("Content-Type")
	if !strings.Contains(ct, "text/event-stream") {
		return io.ReadAll(resp.Body)
	}
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	var last []byte
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "data:") {
			payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
			if payload != "" {
				last = []byte(payload)
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	if last == nil {
		return nil, fmt.Errorf("mcp %q: empty SSE response", resp.Request.URL)
	}
	return last, nil
}

// Initialize performs the MCP handshake.
func (c *Client) Initialize(ctx context.Context) error {
	_, err := c.call(ctx, "initialize", map[string]interface{}{
		"protocolVersion": "2025-03-26",
		"capabilities":    map[string]interface{}{},
		"clientInfo": map[string]interface{}{
			"name":    "grafana-mcp-agent",
			"version": "0.1.0",
		},
	})
	return err
}

// ListTools returns the tools advertised by the server.
func (c *Client) ListTools(ctx context.Context) ([]Tool, error) {
	raw, err := c.call(ctx, "tools/list", map[string]interface{}{})
	if err != nil {
		return nil, err
	}
	var out struct {
		Tools []Tool `json:"tools"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	return out.Tools, nil
}

// CallTool invokes a tool and returns a text rendering of its content blocks.
func (c *Client) CallTool(ctx context.Context, name string, args json.RawMessage) (string, bool, error) {
	raw, err := c.call(ctx, "tools/call", map[string]interface{}{
		"name":      name,
		"arguments": json.RawMessage(args),
	})
	if err != nil {
		return "", true, err
	}
	var out struct {
		IsError bool `json:"isError"`
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return "", true, err
	}
	var b strings.Builder
	for _, block := range out.Content {
		if block.Type == "text" {
			b.WriteString(block.Text)
			b.WriteString("\n")
		}
	}
	return strings.TrimSpace(b.String()), out.IsError, nil
}
