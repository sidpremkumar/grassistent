import { useState } from 'react';
import { css } from '@emotion/css';
import { AppPluginMeta, GrafanaTheme2, PluginConfigPageProps, PluginMeta } from '@grafana/data';
import { getBackendSrv, locationService } from '@grafana/runtime';
import { Button, Field, FieldSet, IconButton, Input, SecretInput, TextArea, useStyles2 } from '@grafana/ui';
import { isSafeIconSrc } from '../lib/branding';
/**
 * Admin configuration page for the MCP Agent plugin.
 *
 * Stores non-secret settings in jsonData (Bedrock region/model, MCP server list)
 * and secrets in secureJSONData (optional static AWS creds, per-MCP auth header
 * values). Secrets never round-trip to the browser once set.
 */

type MCPServerForm = {
  name: string;
  url: string;
  authHeader: string;
  /** Operator guidance on how the agent should use this server's tools. */
  context: string;
  /** Comma/newline-separated tool allowlist; empty = expose every tool. */
  tools: string;
};

/** Shape persisted in jsonData (tools as an array, matching the Go backend). */
type MCPServerConfig = {
  name: string;
  url: string;
  authHeader?: string;
  context?: string;
  tools?: string[];
};

type JsonData = {
  bedrockRegion?: string;
  modelId?: string;
  maxToolIterations?: number;
  systemPrompt?: string;
  mcpServers?: MCPServerConfig[];
  brandIcon?: string;
  brandName?: string;
  brandSubtitle?: string;
};

type SecureFields = Record<string, boolean>;

type Props = PluginConfigPageProps<AppPluginMeta<JsonData>>;

const PLUGIN_ID = 'mcpagent-app';

/** jsonData server entry -> editable form row. */
function toServerForm(cfg: MCPServerConfig): MCPServerForm {
  return {
    name: cfg.name ?? '',
    url: cfg.url ?? '',
    authHeader: cfg.authHeader ?? '',
    context: cfg.context ?? '',
    tools: (cfg.tools ?? []).join(', '),
  };
}

/** Editable form row -> jsonData server entry (tools string -> array). */
function toServerConfig(form: MCPServerForm): MCPServerConfig {
  const tools = form.tools
    .split(/[\n,]/)
    .map((t) => t.trim())
    .filter(Boolean);
  return {
    name: form.name,
    url: form.url,
    authHeader: form.authHeader || undefined,
    context: form.context.trim() || undefined,
    tools: tools.length > 0 ? tools : undefined,
  };
}

export function ConfigPage({ plugin }: Props) {
  const styles = useStyles2(getStyles);
  const meta = plugin.meta;
  const jsonData = meta.jsonData ?? {};
  const secureFields: SecureFields = (meta.secureJsonFields as SecureFields) ?? {};

  const [region, setRegion] = useState(jsonData.bedrockRegion ?? 'us-east-1');
  const [modelId, setModelId] = useState(
    jsonData.modelId ?? 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
  );
  const [maxIter, setMaxIter] = useState<number>(jsonData.maxToolIterations ?? 12);
  const [systemPrompt, setSystemPrompt] = useState(jsonData.systemPrompt ?? '');
  const [servers, setServers] = useState<MCPServerForm[]>(
    (jsonData.mcpServers ?? []).map(toServerForm),
  );

  /* Branding (optional): custom icon (base64 data URI or URL) + labels. */
  const [brandIcon, setBrandIcon] = useState(jsonData.brandIcon ?? '');
  const [brandName, setBrandName] = useState(jsonData.brandName ?? '');
  const [brandSubtitle, setBrandSubtitle] = useState(jsonData.brandSubtitle ?? '');
  const [iconError, setIconError] = useState('');

  /* Secret inputs: track pending values + whether each is already configured. */
  const [awsKey, setAwsKey] = useState('');
  const [awsSecret, setAwsSecret] = useState('');
  const [mcpSecrets, setMcpSecrets] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const addServer = () =>
    setServers((s) => [...s, { name: '', url: '', authHeader: '', context: '', tools: '' }]);
  const removeServer = (idx: number) => setServers((s) => s.filter((_, i) => i !== idx));
  const patchServer = (idx: number, patch: Partial<MCPServerForm>) =>
    setServers((s) => s.map((srv, i) => (i === idx ? { ...srv, ...patch } : srv)));

  /* Reads a chosen image file into a base64 data URI stored in jsonData, so the
   * icon travels with the plugin settings (no external hosting needed). Capped
   * at ~256KB to stay well under the settings payload limits. */
  const MAX_ICON_BYTES = 256 * 1024;
  const onIconFile = (file: File | undefined) => {
    setIconError('');
    if (!file) {
      return;
    }
    if (!file.type.startsWith('image/')) {
      setIconError('Please choose an image file.');
      return;
    }
    if (file.size > MAX_ICON_BYTES) {
      setIconError('Image is too large (max 256KB). Use a smaller SVG/PNG.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setBrandIcon(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => setIconError('Could not read that file.');
    reader.readAsDataURL(file);
  };

  const save = async () => {
    setSaving(true);
    const secureJsonData: Record<string, string> = {};
    if (awsKey) {
      secureJsonData.awsAccessKeyId = awsKey;
    }
    if (awsSecret) {
      secureJsonData.awsSecretAccessKey = awsSecret;
    }
    for (const [name, value] of Object.entries(mcpSecrets)) {
      if (value) {
        secureJsonData[`mcpSecret_${name}`] = value;
      }
    }

    try {
      await getBackendSrv().post(`/api/plugins/${PLUGIN_ID}/settings`, {
        enabled: true,
        pinned: true,
        jsonData: {
          bedrockRegion: region,
          modelId,
          maxToolIterations: Number(maxIter) || 12,
          systemPrompt,
          mcpServers: servers.map(toServerConfig),
          brandIcon: brandIcon.trim(),
          brandName: brandName.trim(),
          brandSubtitle: brandSubtitle.trim(),
        },
        secureJsonData,
      });
      locationService.reload();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={styles.root} data-testid="mcpagent-config">
      <FieldSet label="Model (AWS Bedrock)">
        <Field label="Region" description="AWS region hosting the Bedrock model.">
          <Input value={region} onChange={(e) => setRegion(e.currentTarget.value)} width={40} />
        </Field>
        <Field label="Model ID" description="Bedrock model ID or inference profile ARN.">
          <Input value={modelId} onChange={(e) => setModelId(e.currentTarget.value)} width={60} />
        </Field>
        <Field label="Max tool iterations" description="Upper bound on the agent tool loop per turn.">
          <Input
            type="number"
            value={maxIter}
            onChange={(e) => setMaxIter(Number(e.currentTarget.value))}
            width={20}
          />
        </Field>
        <Field
          label="System prompt (optional)"
          description="Override the default agent system prompt."
        >
          <Input value={systemPrompt} onChange={(e) => setSystemPrompt(e.currentTarget.value)} width={80} />
        </Field>
      </FieldSet>

      <FieldSet label="AWS credentials (optional)">
        <p className={styles.hint}>
          Leave blank to use the default AWS credential chain (IRSA, instance role, environment). Set static
          keys only if you must.
        </p>
        <Field label="Access key ID">
          <SecretInput
            isConfigured={Boolean(secureFields.awsAccessKeyId)}
            value={awsKey}
            width={50}
            onChange={(e) => setAwsKey(e.currentTarget.value)}
            onReset={() => setAwsKey('')}
          />
        </Field>
        <Field label="Secret access key">
          <SecretInput
            isConfigured={Boolean(secureFields.awsSecretAccessKey)}
            value={awsSecret}
            width={50}
            onChange={(e) => setAwsSecret(e.currentTarget.value)}
            onReset={() => setAwsSecret('')}
          />
        </Field>
      </FieldSet>

      <FieldSet label="MCP servers">
        <p className={styles.hint}>
          HTTP / streamable-HTTP MCP endpoints the agent may call. The optional auth header value is stored as
          a secret.
        </p>
        {servers.map((srv, idx) => (
          <div key={idx} className={styles.serverRow} data-testid="mcpagent-server-row">
            <Field label="Name">
              <Input
                value={srv.name}
                placeholder="skippy"
                onChange={(e) => patchServer(idx, { name: e.currentTarget.value })}
                width={18}
              />
            </Field>
            <Field label="URL">
              <Input
                value={srv.url}
                placeholder="https://host/mcp"
                onChange={(e) => patchServer(idx, { url: e.currentTarget.value })}
                width={40}
              />
            </Field>
            <Field label="Auth header">
              <Input
                value={srv.authHeader}
                placeholder="Authorization"
                onChange={(e) => patchServer(idx, { authHeader: e.currentTarget.value })}
                width={22}
              />
            </Field>
            <Field label="Auth value">
              <SecretInput
                isConfigured={Boolean(srv.name && secureFields[`mcpSecret_${srv.name}`])}
                value={mcpSecrets[srv.name] ?? ''}
                width={30}
                onChange={(e) => setMcpSecrets((m) => ({ ...m, [srv.name]: e.currentTarget.value }))}
                onReset={() => setMcpSecrets((m) => ({ ...m, [srv.name]: '' }))}
              />
            </Field>
            <IconButton
              name="trash-alt"
              aria-label="Remove server"
              onClick={() => removeServer(idx)}
              data-testid="mcpagent-remove-server"
            />
            <Field
              label="Tool allowlist (optional)"
              description="Comma or newline separated tool names to expose from this server. Empty = all tools."
              className={styles.fullWidth}
            >
              <TextArea
                value={srv.tools}
                placeholder="query_loki_logs, list_loki_label_values"
                rows={2}
                onChange={(e) => patchServer(idx, { tools: e.currentTarget.value })}
                data-testid="mcpagent-server-tools"
              />
            </Field>
            <Field
              label="Usage context (optional)"
              description="Guidance for the agent on how to use this server, e.g. which services/labels map to what."
              className={styles.fullWidth}
            >
              <TextArea
                value={srv.context}
                placeholder={'Backend API logs live in loki under {app="backend-api"}. Always scope queries to namespace "prod".'}
                rows={3}
                onChange={(e) => patchServer(idx, { context: e.currentTarget.value })}
                data-testid="mcpagent-server-context"
              />
            </Field>
          </div>
        ))}
        <Button variant="secondary" icon="plus" onClick={addServer} data-testid="mcpagent-add-server">
          Add MCP server
        </Button>
      </FieldSet>

      <FieldSet label="Branding (optional)">
        <p className={styles.hint}>
          Customize the icon and labels shown in the chat panel header, the top-bar button, and the floating
          button. Leave blank to use the defaults.
        </p>
        <Field
          label="Icon"
          description="Paste a base64 data URI (data:image/…) or an image URL, or upload a file (max 256KB, SVG/PNG)."
        >
          <div className={styles.iconRow}>
            {isSafeIconSrc(brandIcon) && (
              <span className={styles.iconPreview}>
                <img src={brandIcon} alt="" aria-hidden />
              </span>
            )}
            <Input
              value={brandIcon}
              placeholder="data:image/svg+xml;base64,… or https://…/logo.svg"
              onChange={(e) => setBrandIcon(e.currentTarget.value)}
              width={70}
              data-testid="mcpagent-brand-icon"
            />
            <label className={styles.upload}>
              Upload…
              <input
                type="file"
                accept="image/*"
                onChange={(e) => onIconFile(e.currentTarget.files?.[0])}
                data-testid="mcpagent-brand-icon-file"
              />
            </label>
            {brandIcon && (
              <IconButton
                name="trash-alt"
                aria-label="Clear icon"
                tooltip="Clear icon"
                onClick={() => {
                  setBrandIcon('');
                  setIconError('');
                }}
              />
            )}
          </div>
        </Field>
        {iconError && <p className={styles.error}>{iconError}</p>}
        <Field label="Name" description="Title shown in the panel header (default “MCP Agent”).">
          <Input
            value={brandName}
            placeholder="MCP Agent"
            onChange={(e) => setBrandName(e.currentTarget.value)}
            width={40}
            data-testid="mcpagent-brand-name"
          />
        </Field>
        <Field
          label="Subtitle"
          description="Text under the name (default “Context-aware assistant”)."
        >
          <Input
            value={brandSubtitle}
            placeholder="Context-aware assistant"
            onChange={(e) => setBrandSubtitle(e.currentTarget.value)}
            width={40}
            data-testid="mcpagent-brand-subtitle"
          />
        </Field>
      </FieldSet>

      <div className={styles.actions}>
        <Button onClick={save} disabled={saving} data-testid="mcpagent-save">
          {saving ? 'Saving\u2026' : 'Save settings'}
        </Button>
      </div>
    </div>
  );
}

/** Grafana passes `PluginMeta` to config pages; re-export narrowing helper. */
export type ConfigPluginMeta = PluginMeta<AppPluginMeta<JsonData>>;

const getStyles = (theme: GrafanaTheme2) => ({
  root: css({ maxWidth: '900px' }),
  hint: css({ color: theme.colors.text.secondary, marginBottom: theme.spacing(1) }),
  error: css({ color: theme.colors.error.text, marginTop: theme.spacing(-1), marginBottom: theme.spacing(1) }),
  iconRow: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
    flexWrap: 'wrap',
  }),
  iconPreview: css({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 34,
    height: 34,
    flexShrink: 0,
    borderRadius: theme.shape.radius.default,
    border: `1px solid ${theme.colors.border.weak}`,
    background: theme.colors.background.secondary,
    '& img': { width: 24, height: 24, objectFit: 'contain' },
  }),
  upload: css({
    display: 'inline-flex',
    alignItems: 'center',
    padding: theme.spacing(0.75, 1.5),
    borderRadius: theme.shape.radius.default,
    border: `1px solid ${theme.colors.border.medium}`,
    background: theme.colors.background.secondary,
    color: theme.colors.text.primary,
    fontSize: theme.typography.bodySmall.fontSize,
    cursor: 'pointer',
    '&:hover': { background: theme.colors.action.hover },
    '& input': { display: 'none' },
  }),
  serverRow: css({
    display: 'flex',
    gap: theme.spacing(1),
    alignItems: 'flex-end',
    flexWrap: 'wrap',
    padding: theme.spacing(1),
    marginBottom: theme.spacing(1),
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
  }),
  fullWidth: css({ flexBasis: '100%' }),
  actions: css({ marginTop: theme.spacing(2) }),
});
