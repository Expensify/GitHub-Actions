#!/bin/bash
#################################################################
#    Lint workflows with https://github.com/kjanat/actionlint    #
#################################################################

# Verify that shellcheck is installed (preinstalled on GitHub Actions runners)
if ! command -v shellcheck &>/dev/null; then
    error "This script requires shellcheck. Please install it and try again"
    exit 1
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)"
readonly SCRIPT_DIR

# To update the actionlint preview, update the ref and the checksums for each platform.
readonly ACTIONLINT_REF="d517adb1a17d8448608ff00dfd968a15180ef569"
readonly CHECKSUMS_FILE="$SCRIPT_DIR/actionlint_checksums.txt"
readonly ACTIONLINT_PATH="$SCRIPT_DIR/actionlint"
readonly REPO_ROOT="${REPO_ROOT:-.}"

source "$SCRIPT_DIR/shellUtils.sh"

title "Lint Github Actions via actionlint (https://github.com/kjanat/actionlint)"

# Make sure there are workflows or actions to check before downloading and running actionlint
WORKFLOWS="$(find "$REPO_ROOT/.github/workflows" -type f \( -name "*.yml" -o -name "*.yaml" \))"
ACTIONS="$(find "$REPO_ROOT" -type f \( -name "action.yml" -o -name "action.yaml" \))"
if [[ -z "$WORKFLOWS" && -z "$ACTIONS" ]]; then
    success "No workflows or actions to check!"
    exit 0
fi

OS="$(uname)"
ARCH="$(uname -m)"
readonly OS ARCH
OS_ARCH=""
if [[ "$OS" == "Darwin" && "$ARCH" == "arm64" ]]; then
    OS_ARCH="darwin_arm64"
elif [[ "$OS" == "Linux" && "$ARCH" == "x86_64" ]]; then
    OS_ARCH="linux_amd64"
elif [[ "$OS" == "Linux" && "$ARCH" == "aarch64" ]]; then
    OS_ARCH="linux_arm64"
else
    error "Unknown architecture, unable to get actionlint tarball name" >&2
    exit 1
fi
readonly OS_ARCH

# Get the expected version and checksums of actionlint
EXPECTED_VERSION="2.0.0-SNAPSHOT-${ACTIONLINT_REF:0:8}"
if ! read -r EXPECTED_CHECKSUM EXPECTED_BINARY_CHECKSUM < <(awk -v arch="$OS_ARCH" '$1 == arch {print $2, $3}' "$CHECKSUMS_FILE"); then
    error "No actionlint checksums for $OS_ARCH" >&2
    exit 1
fi
readonly EXPECTED_VERSION EXPECTED_CHECKSUM EXPECTED_BINARY_CHECKSUM

checksum() {
    sha256sum < "$1" | awk '{print $1}'
}

# Get actionlint binary
if [[ -x "$ACTIONLINT_PATH" && "$(checksum "$ACTIONLINT_PATH")" == "$EXPECTED_BINARY_CHECKSUM" ]]; then
    info "Found actionlint version $EXPECTED_VERSION already installed" >&2
else
    info "Downloading and verifying actionlint version $EXPECTED_VERSION..." >&2

    INSTALL_DIR="$(mktemp -d "$SCRIPT_DIR/actionlint-install.XXXXXX")" || exit 1
    readonly INSTALL_DIR
    readonly TARBALL="$INSTALL_DIR/actionlint.tar.gz"
    trap 'rm -rf -- "$INSTALL_DIR"' EXIT

    CURL_HEADERS=()
    if [[ "$OS" == "Linux" ]]; then
        # Fetch only the layer that contains the binary from the upstream nightly image.
        if ! TOKEN="$(curl -fsSL --retry 3 'https://ghcr.io/token?service=ghcr.io&scope=repository:kjanat/actionlint:pull' | jq -er '.token')"; then
            error "Could not get a public GHCR download token (requires jq)"
            exit 1
        fi
        CURL_HEADERS+=(--header "Authorization: Bearer $TOKEN")
        DOWNLOAD_URL="https://ghcr.io/v2/kjanat/actionlint/blobs/sha256:$EXPECTED_CHECKSUM"
        BINARY_PATH="usr/local/bin/actionlint"
    else
        DOWNLOAD_URL="https://pkg.pr.new/kjanat/actionlint/@kjanat-actionlint/actionlint-darwin-arm64@$ACTIONLINT_REF"
        BINARY_PATH="package/bin/actionlint"
    fi

    # --fail: Makes curl return error on HTTP errors (4xx, 5xx)
    # --location: Follow redirects
    # --retry: Retry on transient errors
    # --retry-delay: Wait between retry attempts
    curl --fail --location \
        --retry 3 \
        --retry-delay 3 \
        "${CURL_HEADERS[@]}" \
        "$DOWNLOAD_URL" \
        --output "$TARBALL"
    CURL_EXIT=$?

    if [[ $CURL_EXIT -ne 0 ]]; then
        case $CURL_EXIT in
            18)
                error "Download failed: partial file transfer (network interrupted)" >&2
                ;;
            22)
                error "Download failed: HTTP error from download server" >&2
                ;;
            28)
                error "Download failed: operation timeout" >&2
                ;;
            56)
                error "Download failed: network connection issue" >&2
                ;;
            *)
                error "Download failed with curl exit code $CURL_EXIT" >&2
                ;;
        esac
        exit "$CURL_EXIT"
    fi

    ACTUAL_CHECKSUM="$(checksum "$TARBALL")"
    readonly ACTUAL_CHECKSUM

    if [[ "$ACTUAL_CHECKSUM" != "$EXPECTED_CHECKSUM" ]] ; then
        error "Checksums did not match, expected $EXPECTED_CHECKSUM, got $ACTUAL_CHECKSUM" >&2
        exit 1
    fi

    tar -xOzf "$TARBALL" "$BINARY_PATH" > "$INSTALL_DIR/actionlint" || exit 1
    if [[ "$(checksum "$INSTALL_DIR/actionlint")" != "$EXPECTED_BINARY_CHECKSUM" ]]; then
        error "Extracted actionlint binary checksum did not match" >&2
        exit 1
    fi
    chmod +x "$INSTALL_DIR/actionlint" && mv "$INSTALL_DIR/actionlint" "$ACTIONLINT_PATH" || exit 1

    INSTALLED_VERSION="$("$ACTIONLINT_PATH" -version | head -n 1)"
    readonly INSTALLED_VERSION
    info "Successfully installed actionlint version $INSTALLED_VERSION" >&2
fi

info "Linting workflows..."
echo
cd "$REPO_ROOT" || exit 1

# If a repo has it's own action lint config, use that. Otherwise, use the one in this repo.
# Note: we've already cd'd into $REPO_ROOT above, so use paths relative to cwd.
CONFIG=""
if [[ ! -f ".github/actionlint.yml" ]] && [[ ! -f ".github/actionlint.yaml" ]]; then
    CONFIG=" -config-file $(readlink -f "$SCRIPT_DIR"/../.github/actionlint.yml)"
    info "Using default Github-Actions repo actionlint.yml" >&2
else
    if [[ -f ".github/actionlint.yml" ]]; then
        CONFIG=" -config-file $(readlink -f ".github/actionlint.yml")"
    elif [[ -f ".github/actionlint.yaml" ]]; then
        CONFIG=" -config-file $(readlink -f ".github/actionlint.yaml")"
    else
        error "Should be unreachable -- previously found a valid local actionlint but cannot find it now..."
        exit 1
    fi
    info "Using actionlint file from this repo" >&2
fi

getRepo() {
    local REPOSITORY="${GITHUB_REPOSITORY:-}"
    if [[ -z "$REPOSITORY" ]]; then
        REPOSITORY="$(git remote get-url origin 2>/dev/null)"
        REPOSITORY="${REPOSITORY#https://github.com/}"
        REPOSITORY="${REPOSITORY#git@github.com:}"
        REPOSITORY="${REPOSITORY%.git}"
    fi
    printf '%s\n' "$REPOSITORY"
}

check_blacksmith_runners() (
    REPOSITORY="$(getRepo)"
    POLICY_DIR="$SCRIPT_DIR/../.github"
    CONFIG_DIR="$(mktemp -d)" || exit 1
    trap 'rm -rf -- "$CONFIG_DIR"' EXIT
    # Merge the repository's baseline into the shared Blacksmith actionlint config.
    jq --arg config "$POLICY_DIR/blacksmith-actionlint.yml" --arg repository "$REPOSITORY" '
        {
            extends: [$config],
            ignores: [
                (.[$repository] // {} | to_entries[]) as $workflow
                | $workflow.value[] as $job
                | {rule: "runner-label", file: $workflow.key, job: $job}
            ]
        }
    ' "$POLICY_DIR/blacksmith-runner-baseline.json" > "$CONFIG_DIR/blacksmith-actionlint.json" || exit 1

    "$ACTIONLINT_PATH" check \
        --offline \
        --no-tools \
        --output-format github \
        --config "$CONFIG_DIR/blacksmith-actionlint.json" \
        --runner-provider snapshot \
        --runner-scope expensify-blacksmith \
        --runner-snapshot "$POLICY_DIR/blacksmith-runners.json" \
        -- .github/workflows
)

BLACKSMITH_STATUS=0
if [[ -n "$WORKFLOWS" ]]; then
    check_blacksmith_runners || BLACKSMITH_STATUS=$?
fi

# Roll out newly blocking v2 diagnostics separately from runner policy.

# We can't quote CONFIG here because we need the splitting on spaces for it to be recognized
# by actionlint as a flag
#shellcheck disable=SC2086
if ! "$ACTIONLINT_PATH" \
    ${CONFIG} \
    -color \
    --offline \
    --tool shellcheck=shellcheck \
    --no-tool ruff \
    --ignore missing-permissions \
    --ignore script-interpolation/unknown-script-value \
    --ignore script-injection/secret-interpolation; then
    error "Workflows did not pass actionlint :("
    exit 1
fi

if [[ "$BLACKSMITH_STATUS" -ne 0 ]]; then
    error "Workflows did not pass the Blacksmith runner check"
    exit "$BLACKSMITH_STATUS"
fi

success "Workflows passed actionlint!"
