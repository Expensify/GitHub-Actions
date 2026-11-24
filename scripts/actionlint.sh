#!/bin/bash
#################################################################
#    Lint workflows with https://github.com/kjanat/actionlint    #
#################################################################

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)"
readonly SCRIPT_DIR
readonly ACTIONLINT_PATH="$SCRIPT_DIR/actionlint"
readonly REPO_ROOT="${REPO_ROOT:-.}"
readonly POLICY_DIR="$SCRIPT_DIR/../.github"
# Runner snapshots require a v2 preview.
readonly ACTIONLINT_REF="d517adb1a17d8448608ff00dfd968a15180ef569"

source "$SCRIPT_DIR/shellUtils.sh"

checksum_matches() {
    local actual
    actual="$(sha256sum < "$2")" && [[ "${actual%% *}" == "$1" ]]
}

install_actionlint() (
    local platform archive_sha binary_sha tmp_dir url entry token answer
    local -a curl_args=(-fsSL --retry 3)
    platform="$(uname -s)/$(uname -m)"
    read -r archive_sha binary_sha < <(awk -v platform="$platform" '$1 == platform {print $2, $3}' "$SCRIPT_DIR/actionlint_checksums.txt")
    if [[ -z "$archive_sha" || -z "$binary_sha" ]]; then
        error "No pinned actionlint binary for $platform"
        return 1
    fi
    if [[ -x "$ACTIONLINT_PATH" ]] && checksum_matches "$binary_sha" "$ACTIONLINT_PATH"; then
        return 0
    fi

    # The org ruleset calls the script directly, so GitHub Actions bootstraps the pinned binary.
    if [[ "$1" != "explicit" && "${GITHUB_ACTIONS:-}" != "true" ]]; then
        if [[ ! -t 0 || ! -t 2 ]]; then
            error "The pinned actionlint binary is required. Run $0 --install before linting"
            return 1
        fi
        if ! read -r -p "Download and install the pinned actionlint binary? [y/n] " answer || [[ "$answer" != [yY] ]]; then
            error "The pinned actionlint binary is not installed"
            return 1
        fi
    fi

    if [[ "$platform" == Linux/* ]]; then
        # Fetch only the layer that contains the binary from the upstream nightly image.
        if ! token="$(curl "${curl_args[@]}" 'https://ghcr.io/token?service=ghcr.io&scope=repository:kjanat/actionlint:pull' | jq -er '.token')"; then
            error "Could not get a public GHCR download token (requires jq)"
            return 1
        fi
        curl_args+=(--header "Authorization: Bearer $token")
        url="https://ghcr.io/v2/kjanat/actionlint/blobs/sha256:$archive_sha"
        entry="usr/local/bin/actionlint"
    else
        url="https://pkg.pr.new/kjanat/actionlint/@kjanat-actionlint/actionlint-darwin-arm64@$ACTIONLINT_REF"
        entry="package/bin/actionlint"
    fi

    info "Downloading and verifying the pinned actionlint binary..."
    tmp_dir="$(mktemp -d "$SCRIPT_DIR/actionlint-install.XXXXXX")" || return 1
    trap 'rm -rf -- "$tmp_dir"' EXIT
    if ! curl "${curl_args[@]}" "$url" -o "$tmp_dir/actionlint.tar.gz" ||
        ! checksum_matches "$archive_sha" "$tmp_dir/actionlint.tar.gz" ||
        ! tar -xOzf "$tmp_dir/actionlint.tar.gz" "$entry" > "$tmp_dir/actionlint" ||
        ! checksum_matches "$binary_sha" "$tmp_dir/actionlint" ||
        ! chmod +x "$tmp_dir/actionlint" ||
        ! mv -f "$tmp_dir/actionlint" "$ACTIONLINT_PATH"; then
        error "Could not download, verify, or install the pinned actionlint binary for $platform"
        return 1
    fi
)

if [[ "$#" -eq 1 && "$1" == "--install" ]]; then
    install_actionlint explicit
    exit $?
elif [[ "$#" -ne 0 ]]; then
    error "Usage: $0 [--install]"
    exit 1
fi

title "Lint Github Actions via actionlint (https://github.com/kjanat/actionlint)"

cd "$REPO_ROOT" || exit 1

# Only install actionlint if there is a workflow or action to check.
WORKFLOWS=""
if [[ -d ".github/workflows" ]]; then
    WORKFLOWS="$(find .github/workflows -type f \( -name "*.yml" -o -name "*.yaml" \))"
fi
if [[ -z "$WORKFLOWS" && -z "$(find . -type f \( -name "action.yml" -o -name "action.yaml" \))" ]]; then
    success "No workflows or actions to check!"
    exit 0
fi

if ! command -v shellcheck &>/dev/null; then
    error "This script requires shellcheck. Please install it and try again"
    exit 1
fi

install_actionlint auto || exit 1

if [[ -n "$WORKFLOWS" ]]; then
    info "Checking Blacksmith runner labels..."
    if ! "$ACTIONLINT_PATH" check --offline --no-tools --output-format github \
        --config "$POLICY_DIR/blacksmith-actionlint.yml" --runner-provider snapshot \
        --runner-scope expensify-blacksmith --runner-snapshot "$POLICY_DIR/blacksmith-runners.json" \
        -- .github/workflows; then
        warning "The advisory Blacksmith runner check failed"
    fi
fi

CONFIG="$POLICY_DIR/actionlint.yml"
if [[ -f ".github/actionlint.yml" ]]; then
    CONFIG=".github/actionlint.yml"
elif [[ -f ".github/actionlint.yaml" ]]; then
    CONFIG=".github/actionlint.yaml"
fi

info "Linting workflows and actions..."
# Roll out newly blocking v2 diagnostics separately from runner policy.
if ! "$ACTIONLINT_PATH" check --offline --config "$CONFIG" --color=always \
    --tool shellcheck=shellcheck --no-tool ruff \
    --ignore missing-permissions \
    --ignore script-interpolation/unknown-script-value \
    --ignore script-injection/secret-interpolation; then
    error "Workflows did not pass actionlint :("
    exit 1
fi

success "Workflows passed actionlint!"
