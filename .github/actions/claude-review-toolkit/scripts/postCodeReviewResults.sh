#!/bin/bash

# Post the result of a Claude code review.
# With no violations: adds a "+1" reaction to the PR.
# With violations: posts one inline comment per violation parsed from $STRUCTURED_OUTPUT.
# Usage: postCodeReviewResults.sh <PR_NUMBER>
# Env: STRUCTURED_OUTPUT (JSON from claude-code-action), GH_TOKEN, GITHUB_REPOSITORY, ALLOWED_RULES_FILE
set -eu

if [[ $# -lt 1 ]]; then
    echo "Usage: $0 <PR_NUMBER>" >&2
    exit 1
fi

if ! [[ "$1" =~ ^[0-9]+$ ]]; then
    echo "Error: PR_NUMBER must be a positive integer" >&2
    exit 1
fi

if [[ -z "${STRUCTURED_OUTPUT:-}" ]]; then
    echo "::error::Claude Code Action returned empty structured output" >&2
    exit 1
fi

readonly PR_NUMBER="$1"

COUNT=$(echo "$STRUCTURED_OUTPUT" | jq '.violations | length')
readonly COUNT

if [[ "$COUNT" -eq 0 ]]; then
    addPrReaction.sh "$PR_NUMBER" "+1"
else
    echo "$STRUCTURED_OUTPUT" | jq -c '.violations[]' | while IFS= read -r violation; do
        PATH_ARG=$(echo "$violation" | jq -r '.path')
        BODY_ARG=$(echo "$violation" | jq -r '.body')
        LINE_ARG=$(echo "$violation" | jq -r '.line')
        createInlineComment.sh "$PR_NUMBER" "$PATH_ARG" "$BODY_ARG" "$LINE_ARG" || true
    done
fi
