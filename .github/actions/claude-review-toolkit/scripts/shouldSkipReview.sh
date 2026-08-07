#!/bin/bash

# Decide whether an AI review already completed for the PR's current head commit.
# Writes "head_sha=<sha>" and "skip=true|false" to $GITHUB_OUTPUT.
# Usage: shouldSkipReview.sh <PR_NUMBER> <CONTEXT>
# Env: GH_TOKEN, GITHUB_REPOSITORY, GITHUB_OUTPUT
set -eu

if [[ $# -lt 2 ]]; then
    echo "Usage: $0 <PR_NUMBER> <CONTEXT>" >&2
    exit 1
fi

if ! [[ "$1" =~ ^[0-9]+$ ]]; then
    echo "Error: PR_NUMBER must be a positive integer" >&2
    exit 1
fi

if ! [[ "$2" =~ ^[a-z0-9]([a-z0-9/_-]*[a-z0-9])?$ ]]; then
    echo "Error: CONTEXT must be lowercase alphanumeric with '/', '_' or '-' separators" >&2
    exit 1
fi

readonly PR_NUMBER="$1"
readonly CONTEXT="$2"
readonly REPO="${GITHUB_REPOSITORY}"

HEAD_SHA=$(gh api "/repos/$REPO/pulls/$PR_NUMBER" --jq '.head.sha')
readonly HEAD_SHA

if [[ -z "$HEAD_SHA" ]]; then
    echo "::error::Could not resolve head SHA for PR #$PR_NUMBER" >&2
    exit 1
fi

# The combined status endpoint returns only the most recent status per context.
STATE=$(gh api "/repos/$REPO/commits/$HEAD_SHA/status" --jq ".statuses[] | select(.context == \"$CONTEXT\") | .state")
readonly STATE

echo "head_sha=$HEAD_SHA" >> "$GITHUB_OUTPUT"

if [[ "$STATE" == "success" ]]; then
    echo "$CONTEXT already completed for $HEAD_SHA, skipping review" >&2
    echo "skip=true" >> "$GITHUB_OUTPUT"
else
    echo "skip=false" >> "$GITHUB_OUTPUT"
fi
