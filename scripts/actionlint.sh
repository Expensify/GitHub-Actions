#!/bin/bash
#################################################################
#    Lint workflows with https://github.com/rhysd/actionlint    #
#################################################################

# Verify that shellcheck is installed (preinstalled on GitHub Actions runners)
if ! command -v shellcheck &>/dev/null; then
    error "This script requires shellcheck. Please install it and try again"
    exit 1
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)"
readonly SCRIPT_DIR

# To update the actionlint version, replace this file with the updated checksums file from the GitHub release
readonly CHECKSUMS_FILE="$SCRIPT_DIR/actionlint_checksums.txt"
readonly ACTIONLINT_PATH="$SCRIPT_DIR/actionlint"
readonly REPO_ROOT="${REPO_ROOT:-.}"

source "$SCRIPT_DIR/shellUtils.sh"

title "Lint Github Actions via actionlint (https://github.com/rhysd/actionlint)"

# Make sure there are workflows or actions to check before downloading and running actionlint
WORKFLOWS="$(find "$REPO_ROOT/.github/workflows" -type f \( -name "*.yml" -o -name "*.yaml" \))"
ACTIONS="$(find "$REPO_ROOT" -type f \( -name "action.yml" -o -name "action.yaml" \))"
if [[ -z "$WORKFLOWS" && -z "$ACTIONS" ]]; then
    success "No workflows or actions to check!"
    exit 0
fi

# Get the actionlint tarball name from the checksums file, used both for downloading and verifying checksums
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
TARBALL_NAME="$(grep "$OS_ARCH" "$CHECKSUMS_FILE" | awk '{print $2}')"
readonly TARBALL_NAME

# Get the expected version and checksum of actionlint binary
EXPECTED_VERSION="$(echo "$TARBALL_NAME" | grep -oE "actionlint_[0-9\.]+_" | awk -F_ '{print $2}')"
EXPECTED_CHECKSUM="$(grep "$TARBALL_NAME" "$CHECKSUMS_FILE" | awk '{print $1}')"
readonly EXPECTED_VERSION EXPECTED_CHECKSUM

# Get actionlint binary
if [[ -x "$ACTIONLINT_PATH" && "$EXPECTED_VERSION" == "$("$ACTIONLINT_PATH" -version | head -n 1)" ]]; then
    info "Found actionlint version $EXPECTED_VERSION already installed" >&2
else
    info "Downloading and verifying actionlint verion $EXPECTED_VERSION..." >&2

    readonly TARBALL="$SCRIPT_DIR/actionlint.tar.gz"

    # --fail: Makes curl return error on HTTP errors (4xx, 5xx)
    # --location: Follow redirects
    # --retry: Retry on transient errors
    # --retry-delay: Wait between retry attempts
    curl --fail --location \
        --retry 3 \
        --retry-delay 3 \
        "https://github.com/rhysd/actionlint/releases/download/v${EXPECTED_VERSION}/${TARBALL_NAME}" \
        --output "$TARBALL"
    CURL_EXIT=$?

    if [[ $CURL_EXIT -ne 0 ]]; then
        case $CURL_EXIT in
            18)
                error "Download failed: partial file transfer (network interrupted)" >&2
                ;;
            22)
                error "Download failed: HTTP error from GitHub" >&2
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

    # Ensure tarball is cleaned up
    trap 'rm -f "$TARBALL"' EXIT
    ACTUAL_CHECKSUM="$(sha256sum "$TARBALL" | awk '{print $1}')"
    readonly ACTUAL_CHECKSUM

    if [[ "$ACTUAL_CHECKSUM" != "$EXPECTED_CHECKSUM" ]] ; then
        error "Checksums did not match, expected $EXPECTED_CHECKSUM, got $ACTUAL_CHECKSUM" >&2
        exit 1
    fi

    readonly TMPDIR="${SCRIPT_DIR}/actionlint-${EXPECTED_VERSION}"
    mkdir -p "$TMPDIR"

    # It's only possible to have one exit trap, so we have to update to include both items we wish to remove
    trap 'rm -rf "$TMPDIR" "$TARBALL"' EXIT
    tar -C "$TMPDIR" -xzf "$TARBALL"
    mv "$TMPDIR/actionlint" "$ACTIONLINT_PATH"

    INSTALLED_VERSION="$("$ACTIONLINT_PATH" -version | head -n 1)"
    readonly INSTALLED_VERSION
    info "Successfully installed actionlint version $INSTALLED_VERSION" >&2
fi

info "Linting workflows..."
echo
cd "$REPO_ROOT" || exit 1

# If a repo has it's own action lint config, use that. Otherwise, use the one in this repo.
$CONFIG=""
if [[ ! -f "$REPO_ROOT/.github/actionlint.yml" ]] && [[ ! -f "$REPO_ROOT/.github/actionlint.yaml" ]]; then
    CONFIG="-config-file $SCRIPT_DIR/../.github/actionlint.yml"
fi

if ! "$ACTIONLINT_PATH" -color "$CONFIG"; then
    error "Workflows did not pass actionlint :("
    exit 1
fi

success "Workflows passed actionlint!"
