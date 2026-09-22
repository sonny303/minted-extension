#!/usr/bin/env bash
set -euo pipefail

# Helper script to build and produce a clean Chrome Web Store ZIP package.
# Usage: ./scripts/package-extension.sh [version]

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

VERSION="${1:-$(node -p "require('./package.json').version")}"
MANIFEST_VERSION="$(node -p "require('./public/manifest.json').version")"

if [[ "$VERSION" != "$MANIFEST_VERSION" ]]; then
  echo "Error: Version mismatch! package.json has '$VERSION' but public/manifest.json has '$MANIFEST_VERSION'."
  echo "Bump both files to the same version before packaging."
  exit 1
fi

echo "==> Building extension v${VERSION}..."
npm run build

ZIP_NAME="minted-panel-workbench-v${VERSION}.zip"
ZIP_PATH="${REPO_ROOT}/${ZIP_NAME}"

echo "==> Packaging ${ZIP_PATH} directly from dist/..."
rm -f "$ZIP_PATH"
(
  cd dist
  zip -qr "$ZIP_PATH" . -x '.*' -x '__MACOSX*'
)

echo "==> Verifying package contents..."
if ! unzip -l "$ZIP_PATH" | grep -q " manifest.json$"; then
  echo "Error: manifest.json is NOT at the root of the archive!"
  exit 1
fi

if unzip -l "$ZIP_PATH" | grep -q "__MACOSX"; then
  echo "Error: Archive contains __MACOSX metadata files!"
  exit 1
fi

echo "==> Package verified successfully: ${ZIP_PATH}"
unzip -l "$ZIP_PATH"
