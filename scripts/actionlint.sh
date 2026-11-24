#!/bin/bash
#################################################################
#    Lint workflows with https://github.com/kjanat/actionlint    #
#################################################################

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)"
readonly SCRIPT_DIR
readonly ACTIONLINT_PATH="$SCRIPT_DIR/actionlint"
readonly REPO_ROOT="${REPO_ROOT:-.}"
readonly POLICY_DIR="$SCRIPT_DIR/../.github"

source "$SCRIPT_DIR/shellUtils.sh"

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

# Runner snapshots require a v2 preview. Require public checksum verification for all modules.
readonly ACTIONLINT_VERSION="v2.0.0-20261123125733-d517adb1a17d"
if [[ ! -x "$ACTIONLINT_PATH" ]] || [[ "$("$ACTIONLINT_PATH" --version | head -n 1)" != "actionlint.kjanat.dev/v2 $ACTIONLINT_VERSION" ]]; then
    if ! command -v go &>/dev/null; then
        error "This script requires Go to install actionlint. Please install Go 1.21 or newer and try again"
        exit 1
    fi
    info "Installing actionlint $ACTIONLINT_VERSION..."
    if ! (cd "$SCRIPT_DIR" && GOWORK=off GOTOOLCHAIN=go1.27.4 GOBIN="$SCRIPT_DIR" \
        GOSUMDB=sum.golang.org GONOSUMDB=none \
        go install "actionlint.kjanat.dev/v2/cmd/actionlint@$ACTIONLINT_VERSION"); then
        error "Could not install actionlint"
        exit 1
    fi
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
