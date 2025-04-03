#!/bin/bash

ROOT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." &>/dev/null && pwd)
readonly ROOT_DIR

source "$ROOT_DIR"/.github/scripts/shellUtils.sh

readonly DIRECTORIES_TO_IGNORE="\
-path $ROOT_DIR/node_modules \
-o -path $ROOT_DIR/vendor \
-o -path $ROOT_DIR/ios/Pods \
-o -path $ROOT_DIR/.husky"

# This lists all shell scripts in this repo except those in directories we want to ignore
# shellcheck disable=SC2086
SHELL_SCRIPTS=$(find "$ROOT_DIR" -type d \( $DIRECTORIES_TO_IGNORE \) -prune -o -name '*.sh' -print)
info "👀 Linting the following shell scripts using ShellCheck:"
echo "$SHELL_SCRIPTS"
echo

PIDS=()
for SHELL_SCRIPT in $SHELL_SCRIPTS; do
    if [[ "$CI" == 'true' ]]; then
        # ShellCheck is installed by default on GitHub Actions ubuntu runners
        shellcheck -e SC1091 "$SHELL_SCRIPT" &
    else
        # Otherwise shellcheck is used via npx
        npx shellcheck -e SC1091 "$SHELL_SCRIPT" &
    fi
    PIDS+=($!)
done

EXIT_CODE=0
for PID in "${PIDS[@]}"; do
  if ! wait "$PID"; then
    EXIT_CODE=1
  fi
done

if [[ $EXIT_CODE -ne 0 ]]; then
    error 'ShellCheck failed for one or more files'
    exit $EXIT_CODE
fi

success 'ShellCheck passed for all files!'
