#!/bin/bash

CURRENT_DIR=$(pwd)
ROOT_DIR=$(dirname "$(dirname "$(realpath "${BASH_SOURCE[0]}")")")

cd "$ROOT_DIR" || exit 1

# Check if GREEN has already been defined
if [ -z "${GREEN+x}" ]; then
  declare -r GREEN=$'\e[1;32m'
fi

# Check if RED has already been defined
if [ -z "${RED+x}" ]; then
  declare -r RED=$'\e[1;31m'
fi

# Check if BLUE has already been defined
if [ -z "${BLUE+x}" ]; then
  declare -r BLUE=$'\e[1;34m'
fi

# Check if TITLE has already been defined
if [ -z "${TITLE+x}" ]; then
  declare -r TITLE=$'\e[1;4;34m'
fi

# Check if RESET has already been defined
if [ -z "${RESET+x}" ]; then
  declare -r RESET=$'\e[0m'
fi

function success {
  echo "🎉 $GREEN$1$RESET"
}

function error {
  echo "💥 $RED$1$RESET"
}

function info {
  echo "$BLUE$1$RESET"
}

function title {
  printf "\n%s%s%s\n" "$TITLE" "$1" "$RESET"
}

function assert_equal {
  if [[ "$1" != "$2" ]]; then
    error "Assertion failed: $1 is not equal to $2"
    exit 1
  else
    success "Assertion passed: $1 is equal to $1"
  fi
}

# Usage: join_by_string <delimiter> ...strings
# example: join_by_string ' + ' 'string 1' 'string 2'
# example: join_by_string ',' "${ARRAY_OF_STRINGS[@]}"
function join_by_string {
  local separator="$1"
  shift
  local first="$1"
  shift
  printf "%s" "$first" "${@/#/$separator}"
}

# Usage: get_abs_path <path>
# Will make a path absolute, resolving any relative paths
# example: get_abs_path "./foo/bar"
get_abs_path() {
    local the_path=$1
    local -a path_elements
    IFS='/' read -ra path_elements <<< "$the_path"

    # If the path is already absolute, start with an empty string.
    # We'll prepend the / later when reconstructing the path.
    if [[ "$the_path" = /* ]]; then
        abs_path=""
    else
        abs_path="$(pwd)"
    fi

    # Handle each path element
    for element in "${path_elements[@]}"; do
        if [ "$element" = "." ] || [ -z "$element" ]; then
            continue
        elif [ "$element" = ".." ]; then
            # Remove the last element from abs_path
            abs_path=$(dirname "$abs_path")
        else
            # Append element to the absolute path
            abs_path="${abs_path}/${element}"
        fi
    done

    # Remove any trailing '/'
    while [[ $abs_path == */ ]]; do
        abs_path=${abs_path%/}
    done

    # Special case for root
    [ -z "$abs_path" ] && abs_path="/"

    # Special case to remove any starting '//' when the input path was absolute
    abs_path=${abs_path/#\/\//\/}

    echo "$abs_path"
}

declare -r DIRECTORIES_TO_IGNORE=(
  './node_modules'
  './vendor'
  './ios/Pods'
  './.husky'
)

# This lists all shell scripts in this repo except those in directories we want to ignore
read -ra IGNORE_DIRS < <(join_by_string ' -o -path ' "${DIRECTORIES_TO_IGNORE[@]}")
SHELL_SCRIPTS=$(find . -type d \( -path "${IGNORE_DIRS[@]}" \) -prune -o -name '*.sh' -print)
info "👀 Linting the following shell scripts using ShellCheck: $SHELL_SCRIPTS"
info

ASYNC_PROCESSES=()
for SHELL_SCRIPT in $SHELL_SCRIPTS; do
  if [[ "$CI" == 'true' ]]; then
    # ShellCheck is installed by default on GitHub Actions ubuntu runners
    shellcheck -e SC1091 "$SHELL_SCRIPT" &
  else
    # Otherwise shellcheck is used via npx
    npx shellcheck -e SC1091 "$SHELL_SCRIPT" &
  fi
  ASYNC_PROCESSES+=($!)
done

EXIT_CODE=0
for PID in "${ASYNC_PROCESSES[@]}"; do
  if ! wait "$PID"; then
    EXIT_CODE=1
  fi
done

cd "$CURRENT_DIR" || exit 1

if [ $EXIT_CODE == 0 ]; then
  success "ShellCheck passed for all files!"
fi

exit $EXIT_CODE