#!/bin/bash

CURRENT_DIR=$(pwd)
ROOT_DIR="$(dirname "$(dirname "$(dirname "$(realpath "${BASH_SOURCE[0]}")")")")"

cd "$ROOT_DIR" || exit 1

source ./.github/scripts/shellUtils.sh

declare -r DIRECTORIES_TO_IGNORE=(
    './node_modules'
    './vendor'
    './ios/Pods'
    './.husky'
)

# This lists all shell scripts in this repo except those in directories we want to ignore
read -ra IGNORE_DIRS < <(join_by_string ' -o -path ' "${DIRECTORIES_TO_IGNORE[@]}")
SHELL_SCRIPTS=$(find . -type d \( -path "${IGNORE_DIRS[@]}" \) -prune -o -name '*.sh' -print)
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

EXIT_CODE=0	await_async_commands
for PID in "${PIDS[@]}"; do	EXIT_CODE=$?
  if ! wait "$PID"; then
    EXIT_CODE=1
  fi
done

cd "$CURRENT_DIR" || exit 1

if [[ $EXIT_CODE == 0 ]]; then
    success "ShellCheck passed for all files!"
fi

exit "$EXIT_CODE"
