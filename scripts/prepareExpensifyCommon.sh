#!/bin/bash
# Builds expensify-common when installed from git. npm git dependencies only pack
# the published `files` list (dist/), which is not committed — so we clone and build.
# Remove this script once expensify-common#918 is published to npm.
set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
readonly INSTALL_DIR="$REPO_ROOT/node_modules/expensify-common"

if [[ -f "$INSTALL_DIR/dist/CLI.js" ]]; then
    exit 0
fi

if [[ ! -d "$INSTALL_DIR" ]]; then
    echo "::error::expensify-common is not installed. Run npm ci first." >&2
    exit 1
fi

readonly SPEC="$(node -e "console.log(require('$REPO_ROOT/package.json').dependencies['expensify-common'])")"
readonly REF="${SPEC##*#}"
if [[ "$REF" == "$SPEC" ]]; then
    echo "::error::expensify-common dependency must pin a git ref (e.g. github:Expensify/expensify-common#e1d0216)." >&2
    exit 1
fi

readonly BUILD_DIR="$(mktemp -d)"
cleanup() {
    rm -rf "$BUILD_DIR"
}
trap cleanup EXIT

echo "Building expensify-common from ref $REF..."
git clone --filter=blob:none --no-checkout "https://github.com/Expensify/expensify-common.git" "$BUILD_DIR"
git -C "$BUILD_DIR" checkout "$REF"
(cd "$BUILD_DIR" && npm ci && npm run build)

mkdir -p "$INSTALL_DIR/dist"
cp -R "$BUILD_DIR/dist/." "$INSTALL_DIR/dist/"
