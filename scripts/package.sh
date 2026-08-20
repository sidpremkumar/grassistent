#!/usr/bin/env bash
#
# Build the plugin (Go backend for linux amd64+arm64, then the frontend) and
# produce a distributable Grafana plugin zip.
#
# Grafana requires the archive to contain a single top-level directory named
# after the plugin id, e.g.  mcpagent-app/plugin.json, mcpagent-app/module.js,
# mcpagent-app/gpx_mcpagent_linux_amd64, ...  Users unzip it into their Grafana
# plugins directory (or ship it via GF_INSTALL_PLUGINS / a volume mount).
#
# The build is UNSIGNED. Consumers must allowlist it:
#   GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=mcpagent-app
#
# Usage:
#   ./scripts/package.sh            # build everything, emit dist-zip/<id>-<version>.zip
#   SKIP_BUILD=1 ./scripts/package.sh   # zip whatever is already in dist/
set -euo pipefail

cd "$(dirname "$0")/.."

PLUGIN_ID="$(node -e "process.stdout.write(require('./src/plugin.json').id)")"
VERSION="$(node -e "process.stdout.write(require('./package.json').version)")"
OUT_DIR="dist-zip"
STAGE_DIR="${OUT_DIR}/${PLUGIN_ID}"
ZIP_PATH="${OUT_DIR}/${PLUGIN_ID}-${VERSION}.zip"

echo "==> Packaging ${PLUGIN_ID} v${VERSION}"

if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
  echo "==> Building Go backend (linux amd64 + arm64)"
  GOOS=linux GOARCH=amd64 go build -o dist/gpx_mcpagent_linux_amd64 ./pkg
  GOOS=linux GOARCH=arm64 go build -o dist/gpx_mcpagent_linux_arm64 ./pkg

  echo "==> Building frontend"
  npm run build
fi

if [[ ! -f dist/module.js || ! -f dist/plugin.json ]]; then
  echo "ERROR: dist/ is missing module.js or plugin.json. Run without SKIP_BUILD." >&2
  exit 1
fi

echo "==> Staging into ${STAGE_DIR}"
rm -rf "${OUT_DIR}"
mkdir -p "${STAGE_DIR}"
cp -r dist/. "${STAGE_DIR}/"

echo "==> Zipping ${ZIP_PATH}"
( cd "${OUT_DIR}" && zip -qr "${PLUGIN_ID}-${VERSION}.zip" "${PLUGIN_ID}" )

# sha1 is what grafana.com / grafana-cli use to verify downloads.
if command -v sha1sum >/dev/null 2>&1; then
  sha1sum "${ZIP_PATH}" | awk '{print $1}' > "${ZIP_PATH}.sha1"
else
  shasum -a 1 "${ZIP_PATH}" | awk '{print $1}' > "${ZIP_PATH}.sha1"
fi

echo "==> Done"
echo "    zip:  ${ZIP_PATH}"
echo "    sha1: $(cat "${ZIP_PATH}.sha1")"
