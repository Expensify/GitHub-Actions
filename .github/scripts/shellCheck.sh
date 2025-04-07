#!/bin/bash

ROOT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." &>/dev/null && pwd)
readonly ROOT_DIR

source "$ROOT_DIR"/.github/scripts/shellUtils.sh

readonly DIRECTORIES_TO_IGNORE="
-path $ROOT_DIR/node_modules
-o -path $ROOT_DIR/vendor
-o -path $ROOT_DIR/ios/Pods
-o -path $ROOT_DIR/.husky"

# This lists all shell scripts in this repo except those in directories we want to ignore
# Note: `-print` is required to prevent pruned directories from being printed
# shellcheck disable=SC2086
SHELL_SCRIPTS="$(find "$ROOT_DIR" -type d \( $DIRECTORIES_TO_IGNORE \) -prune -o -name '*.sh' -print)"
info "👀 Linting the following shell scripts using ShellCheck:"
echo "$SHELL_SCRIPTS"
echo

EXIT_CODE=0
for SHELL_SCRIPT in $SHELL_SCRIPTS; do
    if ! shellcheck -e SC1091 "$SHELL_SCRIPT"; then
        EXIT_CODE=1
    fi
done

if [[ $EXIT_CODE -ne 0 ]]; then
    error "ShellCheck failed for one or more files"
    exit $EXIT_CODE
fi

success "ShellCheck passed for all files!"
