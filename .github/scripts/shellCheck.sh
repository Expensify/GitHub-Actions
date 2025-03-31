#!/bin/bash

CURRENT_DIR=$(pwd)
ROOT_DIR="$(dirname "$(dirname "$(dirname "$(realpath "${BASH_SOURCE[0]}")")")")"

cd "$ROOT_DIR" || exit 1

source ./.github/scripts/utils/async.sh
source ./.github/scripts/utils/shellUtils.sh

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

for SHELL_SCRIPT in $SHELL_SCRIPTS; do
  if [[ "$CI" == 'true' ]]; then
    # ShellCheck is installed by default on GitHub Actions ubuntu runners
    run_async shellcheck -e SC1091 "$SHELL_SCRIPT"
  else
    # Otherwise shellcheck is used via npx
    run_async npx shellcheck -e SC1091 "$SHELL_SCRIPT"
  fi
done

await_async_commands
EXIT_CODE=$?

cd "$CURRENT_DIR" || exit 1

if [ $EXIT_CODE == 0 ]; then
  success "ShellCheck passed for all files!"
fi

exit $EXIT_CODE
