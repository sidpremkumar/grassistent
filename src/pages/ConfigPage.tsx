import { useState } from 'react';
import { css } from '@emotion/css';
import { AppPluginMeta, GrafanaTheme2, PluginConfigPageProps, PluginMeta } from '@grafana/data';
import { getBackendSrv, locationService } from '@grafana/runtime';
import { Button, Field, FieldSet, IconButton, Input, SecretInput, useStyles2 } from '@grafana/ui';

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
};

type JsonData = {
  bedrockRegion?: string;
  modelId?: string;
  maxToolIterations?: number;
  systemPrompt?: string;
  mcpServers?: MCPServerForm[];
};

type SecureFields = Record<string, boolean>;

type Props = PluginConfigPageProps<AppPluginMeta<JsonData>>;

const PLUGIN_ID = 'mcpagent-app';

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
  const [servers, setServers] = useState<MCPServerForm[]>(jsonData.mcpServers ?? []);

  /* Secret inputs: track pending values + whether each is already configured. */
  const [awsKey, setAwsKey] = useState('');
  const [awsSecret, setAwsSecret] = useState('');
  const [mcpSecrets, setMcpSecrets] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const addServer = () => setServers((s) => [...s, { name: '', url: '', authHeader: '' }]);
  const removeServer = (idx: number) => setServers((s) => s.filter((_, i) => i !== idx));
  const patchServer = (idx: number, patch: Partial<MCPServerForm>) =>
    setServers((s) => s.map((srv, i) => (i === idx ? { ...srv, ...patch } : srv)));

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
          mcpServers: servers,
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
          </div>
        ))}
        <Button variant="secondary" icon="plus" onClick={addServer} data-testid="mcpagent-add-server">
          Add MCP server
        </Button>
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
  actions: css({ marginTop: theme.spacing(2) }),
});
