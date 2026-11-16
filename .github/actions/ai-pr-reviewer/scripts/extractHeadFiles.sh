#!/bin/bash

# Copy the PR's changed files at its head commit into a directory, as plain data for the reviewer to read.
# Run from the base branch checkout. The PR head is never checked out, so nothing in it can configure
# or run tools, which is what makes this safe under pull_request_target.
# Usage: extractHeadFiles.sh <HEAD_SHA> <FILE_LIST> <DESTINATION>
# Env: GH_TOKEN (fetches the PR head when the checkout kept no credentials)
#
# FILE_LIST has one repository path per line. Paths that are not files at the head commit, such as a
# submodule pointer, are skipped.
set -euo pipefail

if [[ $# -lt 3 ]]; then
    echo "Usage: $0 <HEAD_SHA> <FILE_LIST> <DESTINATION>" >&2
    exit 1
fi

if ! [[ "$1" =~ ^[0-9a-f]{40}$ ]]; then
    echo "Error: HEAD_SHA must be a full 40-character commit SHA" >&2
    exit 1
fi

readonly HEAD_SHA="$1"
readonly FILE_LIST="$2"
readonly DESTINATION="$3"

# GitHub serves any commit reachable from a ref, and a fork's commits are reachable from the PR's ref
# in the base repository, so fetching the exact commit works for forks too.
AUTH_HEADER="AUTHORIZATION: basic $(printf 'x-access-token:%s' "${GH_TOKEN:-}" | base64 | tr -d '\n')"
readonly AUTH_HEADER
git -c "http.https://github.com/.extraheader=$AUTH_HEADER" fetch --quiet --no-tags --depth=1 origin "$HEAD_SHA"

mkdir -p "$DESTINATION"
while IFS= read -r FILE; do
    [[ -n "$FILE" ]] || continue
    if [[ "$(git cat-file -t "$HEAD_SHA:$FILE" 2> /dev/null)" != "blob" ]]; then
        echo "Skipping $FILE: not a file at $HEAD_SHA" >&2
        continue
    fi
    mkdir -p "$DESTINATION/$(dirname "$FILE")"
    git cat-file blob "$HEAD_SHA:$FILE" > "$DESTINATION/$FILE"
done < "$FILE_LIST"
