#!/bin/bash

# Write the AI review into a collapsed block at the bottom of the PR description, replacing the
# previous block if there is one. Text outside the block is left exactly as people wrote it.
# Usage: postReviewToPrBody.sh <PR_NUMBER> <HEAD_SHA>
# Env: EXECUTION_FILE (claude-code-action's execution_file output), GH_TOKEN, GITHUB_REPOSITORY,
#      GITHUB_SERVER_URL, GITHUB_RUN_ID, and optionally READ_TOKEN, ANTHROPIC_API_KEY, GITHUB_STEP_SUMMARY
set -euo pipefail

# shellcheck source=reviewBlock.sh
source "$(dirname "${BASH_SOURCE[0]}")/reviewBlock.sh"

if [[ $# -lt 2 ]]; then
    echo "Usage: $0 <PR_NUMBER> <HEAD_SHA>" >&2
    exit 1
fi

if ! [[ "$1" =~ ^[0-9]+$ ]]; then
    echo "Error: PR_NUMBER must be a positive integer" >&2
    exit 1
fi

if ! [[ "$2" =~ ^[0-9a-f]{40}$ ]]; then
    echo "Error: HEAD_SHA must be a full 40-character commit SHA" >&2
    exit 1
fi

# The review is read from claude-code-action's execution file rather than its structured_output step
# output, because passing that output through an environment variable fails to start the shell once
# it is over Linux's 128 KB limit for a single environment entry. The last result message holds the
# same structured_output, matching schemas/review-output.json.
STRUCTURED_OUTPUT=$(jq -c '[.[] | select(.type == "result")] | last | .structured_output // empty' "${EXECUTION_FILE:-/dev/null}" 2> /dev/null || true)
if [[ -z "$STRUCTURED_OUTPUT" ]]; then
    echo "::error::The AI reviewer returned no structured output" >&2
    exit 1
fi
readonly STRUCTURED_OUTPUT

readonly PR_NUMBER="$1"
readonly HEAD_SHA="$2"
readonly REPO="${GITHUB_REPOSITORY}"
readonly RUN_URL="${GITHUB_SERVER_URL}/${REPO}/actions/runs/${GITHUB_RUN_ID}"

# GitHub rejects PR descriptions longer than 65536 characters. The margin leaves room for the
# truncation note and for people's later edits.
readonly MAX_BODY_CHARACTERS=65000

# Text goes to jq on stdin, never as an argument: Linux rejects any single argument over 128 KB, which a
# long review or a long multibyte description can pass.
characterCount() {
    jq -Rrs 'length'
}

BLOCKING_COUNT=$(jq -r '.blockingCount' <<< "$STRUCTURED_OUTPUT")
readonly BLOCKING_COUNT
SUGGESTION_COUNT=$(jq -r '.suggestionCount' <<< "$STRUCTURED_OUTPUT")
readonly SUGGESTION_COUNT
REVIEW=$(jq -r '.review' <<< "$STRUCTURED_OUTPUT")

if ! [[ "$BLOCKING_COUNT" =~ ^[0-9]+$ && "$SUGGESTION_COUNT" =~ ^[0-9]+$ ]] || [[ -z "$REVIEW" ]]; then
    echo "::error::The AI reviewer output is missing blockingCount, suggestionCount or review" >&2
    exit 1
fi

# The review is posted publicly, and the model read untrusted PR content that could ask it to print a secret.
for SECRET in "${GH_TOKEN:-}" "${READ_TOKEN:-}" "${ANTHROPIC_API_KEY:-}"; do
    if [[ -n "$SECRET" && "$REVIEW" == *"$SECRET"* ]]; then
        echo "::error::The AI review contains a secret, so it was not posted" >&2
        exit 1
    fi
done

# The verdict follows the open blocking findings rather than the model's own wording, so the summary can
# never say "Approved" next to a blocking finding.
if [[ "$BLOCKING_COUNT" -gt 0 ]]; then
    VERDICT="❌ Changes requested"
else
    VERDICT="✅ Approved"
fi
readonly VERDICT
if [[ "$SUGGESTION_COUNT" -eq 1 ]]; then
    SUGGESTIONS="1 suggestion"
else
    SUGGESTIONS="$SUGGESTION_COUNT suggestions"
fi
readonly SUGGESTIONS
readonly SUMMARY="Expensify AI reviewer: $VERDICT ($BLOCKING_COUNT blocking, $SUGGESTIONS)"

buildBlock() {
    printf '%s\n<details>\n<summary>%s</summary>\n\n%s%s -->\n\n%s\n\n<sub>Reviewed at [%s](https://github.com/%s/commit/%s) by [this workflow run](%s).</sub>\n</details>\n%s' \
        "$REVIEW_BLOCK_START" "$SUMMARY" "$REVIEW_SHA_MARKER_PREFIX" "$HEAD_SHA" "$1" "${HEAD_SHA:0:7}" "$REPO" "$HEAD_SHA" "$RUN_URL" "$REVIEW_BLOCK_END"
}

# Read the description right before writing it, so an edit made while the review ran is kept.
BODY=$(gh api "/repos/$REPO/pulls/$PR_NUMBER" --jq '.body // ""')
readonly BODY
HUMAN_BODY=$(stripReviewBlocks <<< "$BODY")
HUMAN_BODY=$(perl -0777 -pe 's/\s+\z//' <<< "$HUMAN_BODY")
readonly HUMAN_BODY

BLOCK=$(buildBlock "$REVIEW")
if [[ -n "$HUMAN_BODY" ]]; then
    SEPARATOR=$'\n\n'
else
    SEPARATOR=""
fi
readonly SEPARATOR

TOTAL_LENGTH=$(printf '%s' "$HUMAN_BODY$SEPARATOR$BLOCK" | characterCount)
if [[ "$TOTAL_LENGTH" -gt "$MAX_BODY_CHARACTERS" ]]; then
    NOTE=$'\n\n'"**The review was cut short to fit the PR description. The full review is in the [workflow run summary]($RUN_URL).**"
    BLOCK_WITHOUT_REVIEW_LENGTH=$(printf '%s' "$HUMAN_BODY$SEPARATOR$(buildBlock "")$NOTE" | characterCount)
    AVAILABLE=$((MAX_BODY_CHARACTERS - BLOCK_WITHOUT_REVIEW_LENGTH))
    if [[ "$AVAILABLE" -lt 0 ]]; then
        AVAILABLE=0
    fi
    TRUNCATED_REVIEW=$(printf '%s' "$REVIEW" | jq -Rrs --argjson available "$AVAILABLE" '.[0:$available]')
    BLOCK=$(buildBlock "$TRUNCATED_REVIEW$NOTE")
fi
readonly BLOCK

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    buildBlock "$REVIEW" >> "$GITHUB_STEP_SUMMARY"
fi

# Replace the existing block where it is, so text a person added below it stays below it. With no
# block yet, append one.
if [[ -n "$(extractLastReviewBlock <<< "$BODY")" ]]; then
    NEW_BODY=$(replaceReviewBlocks "$BLOCK" <<< "$BODY")
else
    NEW_BODY="$HUMAN_BODY$SEPARATOR$BLOCK"
fi
readonly NEW_BODY

printf '%s' "$NEW_BODY" | jq -Rs '{body: .}' | gh api -X PATCH "/repos/$REPO/pulls/$PR_NUMBER" --input - > /dev/null
echo "Posted: $SUMMARY"
