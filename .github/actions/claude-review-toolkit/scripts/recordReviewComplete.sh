#!/bin/bash

# Record that an AI review completed for a specific commit by setting a commit status.
# A later "ready for review" event reads this status and skips the duplicate review.
# Usage: recordReviewComplete.sh <HEAD_SHA> <CONTEXT> [DESCRIPTION]
# Env: GH_TOKEN, GITHUB_REPOSITORY, GITHUB_SERVER_URL, GITHUB_RUN_ID
#
# CONTEXT names the reviewer, one per reviewer per repo (e.g. "ai-review/claude",
# "ai-review/codex"). GitHub allows one status per context per commit, so a second
# status with the same context replaces the first rather than stacking up. It is also
# the key shouldSkipReview.sh looks for, so both scripts must be passed the same value
# or the review will never be recognised as already done. It shows up as the status's
# label in the PR's checks list.
set -eu

if [[ $# -lt 2 ]]; then
    echo "Usage: $0 <HEAD_SHA> <CONTEXT> [DESCRIPTION]" >&2
    exit 1
fi

if ! [[ "$1" =~ ^[0-9a-f]{40}$ ]]; then
    echo "Error: HEAD_SHA must be a full 40-character commit SHA" >&2
    exit 1
fi

if ! [[ "$2" =~ ^[a-z0-9]([a-z0-9/_-]*[a-z0-9])?$ ]]; then
    echo "Error: CONTEXT must be lowercase alphanumeric with '/', '_' or '-' separators" >&2
    exit 1
fi

readonly HEAD_SHA="$1"
readonly CONTEXT="$2"
# GitHub rejects status descriptions longer than 140 characters.
readonly DESCRIPTION="${3:-Reviewed at this commit}"
readonly TRUNCATED_DESCRIPTION="${DESCRIPTION:0:140}"
readonly REPO="${GITHUB_REPOSITORY}"
readonly RUN_URL="${GITHUB_SERVER_URL}/${REPO}/actions/runs/${GITHUB_RUN_ID}"

gh api -X POST "/repos/$REPO/statuses/$HEAD_SHA" \
    -f state=success \
    -f context="$CONTEXT" \
    -f description="$TRUNCATED_DESCRIPTION" \
    -f target_url="$RUN_URL"
