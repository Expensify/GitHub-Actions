#!/bin/bash

# Decide whether an AI review already completed for the PR's current head commit. Useful when a PR author manually requests a review while the PR is still a draft,
# and then marks it ready for review once the AI review passes. In that case, this skips running the AI review again, since it already completed successfully for the same commit.
# Writes "head_sha=<sha>", "context=<status context>" and "skip=true|false" to $GITHUB_OUTPUT.
# Usage: shouldSkipReview.sh <PR_NUMBER> <CONTEXT>
# Env: GH_TOKEN, GITHUB_REPOSITORY, GITHUB_OUTPUT, GITHUB_EVENT_NAME
#
# An issue_comment run never skips. That event is how someone asks for a review by hand
# ("@claude review", "@codex review"), so it is a deliberate request to review a commit that has
# most likely already been reviewed - the one case where repeating the review is the point.
#
# CONTEXT names the reviewer (e.g. "ai-review-completed/claude", "ai-review-completed/codex").
# Commit statuses belong to a repository commit rather than to a PR, and two PRs can share a head
# SHA - the same branch opened against two different base branches, for example - so the PR number
# is appended to form the status context this looks for. That full context is written to
# $GITHUB_OUTPUT as "context" and must be the value recordReviewComplete.sh is given.
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
readonly STATUS_CONTEXT="$CONTEXT/pr-$PR_NUMBER"
readonly REPO="${GITHUB_REPOSITORY}"

HEAD_SHA=$(gh api "/repos/$REPO/pulls/$PR_NUMBER" --jq '.head.sha')
readonly HEAD_SHA

if [[ -z "$HEAD_SHA" ]]; then
    echo "::error::Could not resolve head SHA for PR #$PR_NUMBER" >&2
    exit 1
fi

# The combined status endpoint returns only the most recent status per context, but it pages at 30
# statuses, so --paginate is needed to see a marker on a commit that carries many other statuses.
STATE=$(gh api --paginate "/repos/$REPO/commits/$HEAD_SHA/status" --jq ".statuses[] | select(.context == \"$STATUS_CONTEXT\") | .state")
readonly STATE

echo "head_sha=$HEAD_SHA" >> "$GITHUB_OUTPUT"
echo "context=$STATUS_CONTEXT" >> "$GITHUB_OUTPUT"

if [[ "${GITHUB_EVENT_NAME:-}" == "issue_comment" ]]; then
    echo "Review requested by comment, running it even if $STATUS_CONTEXT already completed for $HEAD_SHA" >&2
    echo "skip=false" >> "$GITHUB_OUTPUT"
elif [[ "$STATE" == "success" ]]; then
    echo "$STATUS_CONTEXT already completed for $HEAD_SHA, skipping review" >&2
    echo "skip=true" >> "$GITHUB_OUTPUT"
else
    echo "skip=false" >> "$GITHUB_OUTPUT"
fi
