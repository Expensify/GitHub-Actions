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
readonly ACTIONLINT_VERSION="v2.0.0-20261123125733-d517adb1a17d"
readonly GO_VERSION="1.27.4"

source "$SCRIPT_DIR/shellUtils.sh"

actionlint_is_installed() {
    [[ -x "$ACTIONLINT_PATH" ]] &&
        [[ "$("$ACTIONLINT_PATH" --version | head -n 1)" == "actionlint.kjanat.dev/v2 $ACTIONLINT_VERSION" ]]
}

confirm_install() {
    local answer
    read -r -p "$1 [y/n] " answer && [[ "$answer" == [yY] ]]
}

install_actionlint() (
    local mode="$1" go_bin target checksum go_dir
    if actionlint_is_installed; then
        return 0
    fi
    if [[ "$mode" == "prompt" ]] && ! confirm_install "Install actionlint $ACTIONLINT_VERSION?"; then
        error "The required actionlint version is not installed"
        return 1
    fi

    if ! go_bin="$(command -v go)"; then
        if [[ "$mode" != "prompt" ]] || ! confirm_install "Download Go $GO_VERSION to build actionlint?"; then
            error "Go is required to install actionlint. Install Go $GO_VERSION and retry with $0 --install"
            return 1
        fi
        case "$(uname -s)/$(uname -m)" in
            Darwin/arm64)
                target="darwin-arm64"
                checksum="91a44a2b8a716600ad94a4f143e156116620db8828086a6e3602291be9bd0bb4"
                ;;
            Linux/aarch64)
                target="linux-arm64"
                checksum="3392582988a273a87ab5043ee1b2c9c17a2c3c00580bf9326c47a2e0aaaeac92"
                ;;
            Linux/x86_64)
                target="linux-amd64"
                checksum="7226736c2339719cda28fbf3a54d71aa63bcefe376e98cef00034268dab24840"
                ;;
            *)
                error "Install Go $GO_VERSION manually on this platform and retry with $0 --install"
                return 1
                ;;
        esac
        go_dir="$(mktemp -d "${TMPDIR:-/tmp}/actionlint-go.XXXXXX")" || return 1
        trap 'rm -rf -- "$go_dir"' EXIT
        if ! (cd "$go_dir" &&
            curl -fsSL --retry 3 "https://go.dev/dl/go$GO_VERSION.$target.tar.gz" -o go.tar.gz &&
            printf '%s  go.tar.gz\n' "$checksum" | shasum -a 256 -c - &&
            tar -xzf go.tar.gz); then
            error "Could not download or verify Go $GO_VERSION"
            return 1
        fi
        go_bin="$go_dir/go/bin/go"
    fi

    info "Installing actionlint $ACTIONLINT_VERSION..."
    # Verify public modules and use only the Go toolchain already provisioned.
    if ! (cd "$SCRIPT_DIR" && GOWORK=off GOTOOLCHAIN=local GOBIN="$SCRIPT_DIR" \
        GOSUMDB=sum.golang.org GONOSUMDB=none \
        "$go_bin" install "actionlint.kjanat.dev/v2/cmd/actionlint@$ACTIONLINT_VERSION"); then
        error "Could not install actionlint. Use Go $GO_VERSION and retry with $0 --install"
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

if ! actionlint_is_installed; then
    if [[ ! -t 0 || ! -t 2 || "${CI:-}" == "true" ]]; then
        error "actionlint $ACTIONLINT_VERSION is required. Install Go $GO_VERSION and run $0 --install before linting"
        exit 1
    fi
    install_actionlint prompt || exit 1
fi

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
# Roll out the v2-only permissions and unproven interpolation findings separately.
if ! "$ACTIONLINT_PATH" check --offline --config "$CONFIG" --color=always \
    --tool shellcheck=shellcheck --no-tool ruff \
    --ignore missing-permissions --ignore script-interpolation/unknown-script-value; then
    error "Workflows did not pass actionlint :("
    exit 1
fi

success "Workflows passed actionlint!"
