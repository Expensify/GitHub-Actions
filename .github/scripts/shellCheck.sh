#!/bin/bash

SCRIPT_DIR=$(cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd)
ROOT_DIR="$(dirname "$(dirname "$SCRIPT_DIR")")"

source "$SCRIPT_DIR"/shellUtils.sh

declare -r DIRECTORIES_TO_IGNORE=(
    "$ROOT_DIR/node_modules"
    "$ROOT_DIR/vendor"
    "$ROOT_DIR/ios/Pods"
    "$ROOT_DIR/.husky"
)

# This lists all shell scripts in this repo except those in directories we want to ignore
read -ra IGNORE_DIRS < <(join_by_string ' -o -path ' "${DIRECTORIES_TO_IGNORE[@]}")
SHELL_SCRIPTS=$(find "$ROOT_DIR" -type d \( -path "${IGNORE_DIRS[@]}" \) -prune -o -name '*.sh' -print)
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

if [[ $EXIT_CODE == 0 ]]; then
    success 'ShellCheck passed for all files!'
else
    error 'ShellCheck failed for one or more files'
fi

exit $EXIT_CODE
