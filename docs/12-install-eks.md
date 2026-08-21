# Install on self-hosted Grafana in EKS (agent runbook)

Audience: a coding agent (or engineer) with cluster + AWS admin, deploying the
**MCP Agent** Grafana app plugin (`mcpagent-app`) onto **self-hosted Grafana
running in EKS**, with Bedrock access via **IRSA / IAM OIDC** (no static keys).

This is a headless install: no clicking through the Grafana UI. All plugin
config is supplied via environment variables (`MCPAGENT_*`). See
[08-config.md](./08-config.md) for the full config surface and precedence
(UI > env > defaults).

---

## 0. Facts the agent must not get wrong

- **Plugin id**: `mcpagent-app`. Backend executable: `gpx_mcpagent`.
- **It is UNSIGNED.** Grafana refuses to load it unless it is on the unsigned
  allowlist: `GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=mcpagent-app`.
- **Grafana ≥ 12.4 does not forward host env to plugin subprocesses.** You MUST
  set `GF_PLUGINS_FORWARD_HOST_ENV_VARS=mcpagent-app`, or the backend never sees
  `AWS_*` / `MCPAGENT_*` and Bedrock auth fails with `no EC2 IMDS role found`.
- **The backend is amd64 or arm64 Linux only** (binaries `gpx_mcpagent_linux_amd64`,
  `gpx_mcpagent_linux_arm64`). Match your node arch. Grafana auto-selects.
- **Model calls run server-side** in the plugin process. The pod's ServiceAccount
  (via IRSA) is what talks to Bedrock. No secret ever reaches the browser.
- **Requires Grafana ≥ 12.0** (`grafanaDependency` in `plugin.json`). The plugin
  uses `singleTopNav` + `extensionSidebar` feature toggles for its top-bar entry.

---

## 1. Inputs the agent must resolve first

Collect these before writing any Terraform / manifests:

| Value | How to get it | Example |
| --- | --- | --- |
| AWS account id | `aws sts get-caller-identity` | `123456789012` |
| AWS region for Bedrock | must be a region where the model is enabled | `us-east-1` |
| EKS cluster name | existing | `prod-eks` |
| EKS OIDC provider URL | `aws eks describe-cluster --name <c> --query cluster.identity.oidc.issuer --output text` | `https://oidc.eks.us-east-1.amazonaws.com/id/ABC123` |
| Grafana namespace | where Grafana runs | `monitoring` |
| Grafana ServiceAccount name | the SA the Grafana pod uses | `grafana` |
| Bedrock model id | inference-profile id, must be enabled in the account | `us.anthropic.claude-sonnet-4-5-20250929-v1:0` |
| Plugin zip URL | GitHub release asset | `https://github.com/sidpremkumar/grassistent/releases/download/v0.1.0/mcpagent-app-0.1.0.zip` |
| MCP server(s) | name + HTTPS URL (+ optional auth header/value, per-server `context` guidance, `tools` allowlist) | `{"name":"skippy","url":"https://.../mcp"}` |

> The OIDC provider usually already exists for an EKS cluster. If not, create it
> with `aws eks associate-identity-provider-config` or the
> `iam_openid_connect_provider` Terraform resource (see step 2).

---

## 2. IAM via OIDC (Terraform)

Goal: an IAM role assumable **only** by the Grafana pod's ServiceAccount, scoped
to invoke exactly the Bedrock model you use. `ConverseStream` maps to the
`bedrock:InvokeModelWithResponseStream` action; `Converse` maps to
`bedrock:InvokeModel`. Grant both.

Create `bedrock-irsa.tf`:

```hcl
variable "cluster_name"      { type = string }
variable "grafana_namespace" { type = string  default = "monitoring" }
variable "grafana_sa_name"   { type = string  default = "grafana" }
variable "bedrock_region"    { type = string  default = "us-east-1" }

# Model id you configure the plugin with. Used to scope the IAM policy.
# Inference-profile ids (us.anthropic....) require BOTH the profile ARN and the
# underlying foundation-model ARN in the policy Resource list, so we allow the
# whole model family for the region + a wildcard on the account's inference
# profiles. Tighten if you pin a single model.
variable "bedrock_model_arns" {
  type = list(string)
  default = [
    "arn:aws:bedrock:*::foundation-model/anthropic.*",
    "arn:aws:bedrock:*:*:inference-profile/us.anthropic.*"
  ]
}

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

# EKS OIDC provider (reference the existing one).
data "aws_eks_cluster" "this" { name = var.cluster_name }

locals {
  oidc_issuer      = data.aws_eks_cluster.this.identity[0].oidc[0].issuer
  oidc_issuer_host = replace(local.oidc_issuer, "https://", "")
  oidc_provider_arn = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:oidc-provider/${local.oidc_issuer_host}"
}

# If the OIDC provider is NOT yet registered in IAM, uncomment to create it:
# data "tls_certificate" "oidc" { url = local.oidc_issuer }
# resource "aws_iam_openid_connect_provider" "eks" {
#   url             = local.oidc_issuer
#   client_id_list  = ["sts.amazonaws.com"]
#   thumbprint_list = [data.tls_certificate.oidc.certificates[0].sha1_fingerprint]
# }

data "aws_iam_policy_document" "assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [local.oidc_provider_arn]
    }
    # Restrict to the exact Grafana ServiceAccount.
    condition {
      test     = "StringEquals"
      variable = "${local.oidc_issuer_host}:sub"
      values   = ["system:serviceaccount:${var.grafana_namespace}:${var.grafana_sa_name}"]
    }
    condition {
      test     = "StringEquals"
      variable = "${local.oidc_issuer_host}:aud"
      values   = ["sts.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "grafana_mcp_agent" {
  name               = "grafana-mcp-agent-bedrock"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

data "aws_iam_policy_document" "bedrock" {
  statement {
    effect = "Allow"
    actions = [
      "bedrock:InvokeModel",
      "bedrock:InvokeModelWithResponseStream"
    ]
    resources = var.bedrock_model_arns
  }
}

resource "aws_iam_role_policy" "bedrock" {
  name   = "bedrock-invoke"
  role   = aws_iam_role.grafana_mcp_agent.id
  policy = data.aws_iam_policy_document.bedrock.json
}

output "grafana_mcp_agent_role_arn" {
  value = aws_iam_role.grafana_mcp_agent.arn
}
```

Apply, then annotate the Grafana ServiceAccount with the role ARN (this is what
turns on IRSA):

```bash
kubectl annotate serviceaccount -n <grafana_namespace> <grafana_sa_name> \
  eks.amazonaws.com/role-arn=$(terraform output -raw grafana_mcp_agent_role_arn) \
  --overwrite
```

If Grafana is installed via Helm, prefer setting it declaratively instead of the
imperative annotate:

```yaml
# values.yaml (grafana/grafana chart)
serviceAccount:
  create: true
  name: grafana
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/grafana-mcp-agent-bedrock
```

> IRSA also injects `AWS_WEB_IDENTITY_TOKEN_FILE` + `AWS_ROLE_ARN` into the pod.
> The plugin's default AWS credential chain picks these up automatically **as
> long as** `forward_host_env_vars` includes `mcpagent-app` (step 4). Leave the
> plugin's static-key secrets blank.

---

## 3. Get the plugin into Grafana's plugin dir

Grafana loads a plugin from `<plugins_dir>/mcpagent-app/` containing
`plugin.json`, `module.js`, and the matching `gpx_mcpagent_linux_<arch>` binary.
The release ships a zip whose top-level dir is already `mcpagent-app/`.

Pick ONE of the following.

### Option A — `GF_INSTALL_PLUGINS` with a zip URL (simplest)

The official Grafana image installs plugins from a URL at container start. Format
is `<url>;<plugin-id>`:

```yaml
env:
  - name: GF_INSTALL_PLUGINS
    value: "https://github.com/sidpremkumar/grassistent/releases/download/v0.1.0/mcpagent-app-0.1.0.zip;mcpagent-app"
```

Pros: no image rebuild, no init container. Cons: needs egress to GitHub at pod
start; re-downloads on every restart unless the plugins dir is a persistent
volume.

### Option B — initContainer that unpacks the zip onto a shared volume

More robust for locked-down networks (you control the source) and avoids
re-download if the volume persists.

```yaml
volumes:
  - name: grafana-plugins
    emptyDir: {}            # or a PVC to persist across restarts

initContainers:
  - name: install-mcp-agent
    image: curlimages/curl:8.10.1
    command: ["/bin/sh","-c"]
    args:
      - |
        set -eu
        cd /var/lib/grafana/plugins
        curl -fsSL -o /tmp/p.zip "$PLUGIN_ZIP_URL"
        # busybox unzip; strips nothing — zip already has mcpagent-app/ at root
        cd /tmp && unzip -o p.zip -d /var/lib/grafana/plugins
    env:
      - name: PLUGIN_ZIP_URL
        value: "https://github.com/sidpremkumar/grassistent/releases/download/v0.1.0/mcpagent-app-0.1.0.zip"
    volumeMounts:
      - name: grafana-plugins
        mountPath: /var/lib/grafana/plugins

# main grafana container also mounts grafana-plugins at
#   /var/lib/grafana/plugins
```

> `curlimages/curl` has no `unzip`; use an image that does (e.g.
> `alpine:3.20` + `apk add --no-cache curl unzip`) if you go this route.

### Option C — bake into a custom image

```dockerfile
FROM grafana/grafana:13.2.0
ADD https://github.com/sidpremkumar/grassistent/releases/download/v0.1.0/mcpagent-app-0.1.0.zip /tmp/p.zip
USER root
RUN mkdir -p /var/lib/grafana/plugins \
 && (cd /var/lib/grafana/plugins && unzip -o /tmp/p.zip) \
 && rm /tmp/p.zip
USER grafana
```

Most reproducible; requires a registry + image bump per release.

---

## 4. Grafana configuration (env vars)

Set these on the Grafana container (Helm `grafana.ini` / `env` or a ConfigMap).
The first three are **mandatory**; the rest configure the agent headlessly.

```yaml
env:
  # --- MANDATORY plugin loading ---
  - name: GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS
    value: "mcpagent-app"
  - name: GF_PLUGINS_FORWARD_HOST_ENV_VARS      # forward AWS_* + MCPAGENT_* to the plugin process
    value: "mcpagent-app"
  - name: GF_FEATURE_TOGGLES_ENABLE             # top-bar entry + slide-out panel
    value: "singleTopNav,extensionSidebar"

  # --- Bedrock / agent config (headless) ---
  - name: AWS_REGION
    value: "us-east-1"                          # also serves as MCPAGENT_BEDROCK_REGION
  - name: MCPAGENT_MODEL_ID
    value: "us.anthropic.claude-sonnet-4-5-20250929-v1:0"
  - name: MCPAGENT_MAX_TOOL_ITERATIONS
    value: "12"
  # MCP servers the agent can call (JSON array; see 08-config.md).
  # Per server you can set:
  #   - "context": free-text guidance injected into the system prompt, telling
  #     the agent HOW to look things up on that server (e.g. which loki labels
  #     or service names map to "backend api service logs").
  #   - "tools": explicit allowlist of tool names to expose from that server
  #     (empty/omitted = every tool the server advertises).
  - name: MCPAGENT_MCP_SERVERS
    value: >-
      [{"name":"skippy",
        "url":"https://your-host/mcp",
        "authHeader":"Authorization",
        "context":"Backend API service logs live in loki under {app=\"backend-api\"} in namespace prod. For 'get me all backend api service logs' use query_loki_logs with that selector.",
        "tools":["query_loki_logs","list_loki_label_values","query_prometheus"]}]
```

If an MCP server needs an auth value, store it as a **Kubernetes Secret** and
inject it as `MCPAGENT_MCP_SECRET_<NAME>` (name upper-cased, matching the
server's `name`):

```yaml
  - name: MCPAGENT_MCP_SECRET_SKIPPY
    valueFrom:
      secretKeyRef:
        name: mcp-agent-secrets
        key: skippy-auth        # e.g. "Bearer eyJ..."
```

Do **not** set `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` — IRSA supplies
credentials via the default chain.

For the Helm chart, the equivalent is under `grafana.env` (plain env) and
`grafana.envFromSecret` / `extraSecretMounts` for secrets. Feature toggles and
unsigned allowlist can also go in `grafana.ini`:

```yaml
grafana.ini:
  plugins:
    allow_loading_unsigned_plugins: mcpagent-app
    # forward_host_env_vars lives under [plugins] too:
    forward_host_env_vars: mcpagent-app
  feature_toggles:
    enable: singleTopNav extensionSidebar
```

---

## 5. Enable the app

An app plugin's **backend does not start until the app is enabled**. Enable it
one of two ways:

Declaratively via provisioning (preferred — survives restarts). Mount a file at
`/etc/grafana/provisioning/plugins/mcp-agent.yaml`:

```yaml
apiVersion: 1
apps:
  - type: mcpagent-app
    org_id: 1
    disabled: false
```

Or imperatively (one-off, e.g. from a Job or kubectl exec):

```bash
curl -s -u admin:$GF_ADMIN_PASSWORD -X POST \
  http://localhost:3000/api/plugins/mcpagent-app/settings \
  -H 'Content-Type: application/json' \
  -d '{"enabled":true,"pinned":true}'
```

---

## 6. Verify

```bash
# 1. Plugin discovered + backend healthy
kubectl exec -n <ns> deploy/grafana -- \
  curl -s -u admin:$PW http://localhost:3000/api/plugins/mcpagent-app/health
# expect HTTP 200 / {"status":"OK"}

# 2. IRSA is wired (creds present in the plugin process' env)
kubectl exec -n <ns> deploy/grafana -- printenv AWS_ROLE_ARN AWS_WEB_IDENTITY_TOKEN_FILE

# 3. End-to-end streaming through Bedrock (no browser)
kubectl exec -n <ns> deploy/grafana -- curl -s -N -u admin:$PW -X POST \
  http://localhost:3000/api/plugins/mcpagent-app/resources/chat \
  -H 'Content-Type: application/json' \
  -d '{"sessionId":"t","message":"say hello in 3 words","history":[]}' --max-time 35
# expect: data: {"type":"content",...} ... data: {"type":"done"}
```

Then open Grafana in a browser and click **MCP Agent** in the top bar.

---

## 7. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `no EC2 IMDS role found` / Bedrock auth times out | plugin process can't see AWS env | ensure `GF_PLUGINS_FORWARD_HOST_ENV_VARS=mcpagent-app`; confirm the SA annotation + role trust `sub` matches `system:serviceaccount:<ns>:<sa>` |
| Plugin not listed | not on unsigned allowlist, or wrong dir layout | `GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=mcpagent-app`; dir must be `<plugins>/mcpagent-app/plugin.json` |
| Backend won't start | arch mismatch | node arch vs `gpx_mcpagent_linux_<arch>`; check `kubectl logs` for the plugin |
| `AccessDeniedException` from Bedrock | IAM policy too narrow / model not enabled | add the model's ARN to `bedrock_model_arns`; enable model access in the Bedrock console for the region |
| `ResourceNotFoundException` | retired/typo model id | use a current inference-profile id |
| Chat button missing | pre-`singleTopNav` bar | confirm feature toggle; hard-reload; `⌘⇧A` / `Ctrl+Shift+A` opens the chat regardless |
| MCP init fails | URL unreachable from the pod / bad auth | verify egress + `MCPAGENT_MCP_SECRET_<NAME>` |

---

## 8. Upgrading

Bump the release version and re-pull:
- **Option A/B**: point the zip URL at the new release tag and restart the
  Grafana pods (or the initContainer volume if persistent — clear it first).
- **Option C**: rebuild the image with the new zip and roll the deployment.

Then re-run the step 6 health check. Enabling (step 5) persists across upgrades.
