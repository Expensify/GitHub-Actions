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

source "$SCRIPT_DIR/shellUtils.sh"

title "Lint Github Actions via actionlint (https://github.com/rhysd/actionlint)"

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
    if ! curl -sL "https://github.com/rhysd/actionlint/releases/download/v${EXPECTED_VERSION}/${TARBALL_NAME}" -o "$TARBALL"; then
        error "Unable to download actionlint binary"
        exit 1
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
    mv "$TMPDIR/actionlint" "$SCRIPT_DIR/actionlint"

    INSTALLED_VERSION="$("$SCRIPT_DIR/actionlint" -version | head -n 1)"
    readonly INSTALLED_VERSION
    info "Successfully installed actionlint version $INSTALLED_VERSION" >&2
fi

info "Linting workflows..."
echo
if ! "$SCRIPT_DIR/actionlint" -color; then
    error "Workflows did not pass actionlint :("
    exit 1
fi

success "Workflows passed actionlint!"
