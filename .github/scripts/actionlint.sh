#!/bin/bash
#################################################################
#    Lint workflows with https://github.com/rhysd/actionlint    #
#################################################################

# v1.7.7
readonly ACTIONLINT_VERSION=03d0035246f3e81f36aed592ffb4bebf33a03106

# Verify that shellcheck is installed (preinstalled on GitHub Actions runners)
if ! command -v shellcheck &>/dev/null; then
    error 'This script requires shellcheck. Please install it and try again'
    exit 1
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)"
readonly SCRIPT_DIR

source "$SCRIPT_DIR/shellUtils.sh"

title 'Lint Github Actions via actionlint (https://github.com/rhysd/actionlint)'

info 'Downloading actionlint...'
if bash <(curl --silent https://raw.githubusercontent.com/rhysd/actionlint/"$ACTIONLINT_VERSION"/scripts/download-actionlint.bash); then
    success 'Successfully downloaded actionlint!'
    echo

    # Cleanup actionlint when we're done
    trap 'rm -rf ./actionlint' EXIT
else
    error 'Error downloading actionlint'
    exit 1
fi

info 'Linting workflows...'
echo
if ./actionlint -color; then
    success 'Workflows passed actionlint!'
else
    error 'Workflows did not pass actionlint :('
    exit 1
fi
