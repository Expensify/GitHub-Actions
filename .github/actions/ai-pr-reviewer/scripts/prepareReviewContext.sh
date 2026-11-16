#!/bin/bash

# Gather everything the AI PR reviewer reads into one directory, so the model needs no GitHub access.
# Usage: prepareReviewContext.sh <PR_NUMBER> <OUTPUT_DIR>
# Env: GH_TOKEN, GITHUB_REPOSITORY, GITHUB_OUTPUT, READ_TOKEN (optional, reads linked issues in other private repos)
#
# Writes to OUTPUT_DIR:
#   pr.md                          Title, author, branches, SHAs and description (without the review block)
#   pr.diff                        The full PR diff
#   changed-files.md               Every changed file with its status and line counts
#   head-files.txt                 Paths that exist at the head commit, one per line, for extractHeadFiles.sh
#   comments.md                    Conversation comments, review comments and review bodies
#   issues.md                      Linked issues with their comments, or why each was skipped
#   previous-review.md             The earlier review block, when there is one
#   changes-since-last-review.md   Commits and patches since the earlier review (incremental mode only)
#
# Writes to GITHUB_OUTPUT: head_sha, mode (first | incremental | rewritten) and skip (true | false).
# skip is true when the earlier review already covers the current head commit.
set -euo pipefail

# shellcheck source=reviewBlock.sh
source "$(dirname "${BASH_SOURCE[0]}")/reviewBlock.sh"

if [[ $# -lt 2 ]]; then
    echo "Usage: $0 <PR_NUMBER> <OUTPUT_DIR>" >&2
    exit 1
fi

if ! [[ "$1" =~ ^[0-9]+$ ]]; then
    echo "Error: PR_NUMBER must be a positive integer" >&2
    exit 1
fi

readonly PR_NUMBER="$1"
readonly OUTPUT_DIR="$2"
readonly REPO="${GITHUB_REPOSITORY}"
readonly READ_TOKEN="${READ_TOKEN:-${GH_TOKEN}}"
readonly MAX_ISSUES=5
readonly MAX_ISSUE_BYTES=200000

# Large values go to jq through files, never as arguments: Linux rejects any single argument over 128 KB,
# which one big patch or a long multibyte description can pass.
WORK_DIR=$(mktemp -d)
readonly WORK_DIR
trap 'rm -rf "$WORK_DIR"' EXIT

mkdir -p "$OUTPUT_DIR"

PULL=$(gh api "/repos/$REPO/pulls/$PR_NUMBER")
HEAD_SHA=$(jq -r '.head.sha' <<< "$PULL")
readonly HEAD_SHA
IS_PUBLIC_REPO=$(jq -r '.base.repo.private | not' <<< "$PULL")
readonly IS_PUBLIC_REPO
BODY=$(jq -r '.body // ""' <<< "$PULL")
HUMAN_BODY=$(stripReviewBlocks <<< "$BODY")
readonly HUMAN_BODY
PREVIOUS_BLOCK=$(extractLastReviewBlock <<< "$BODY")
readonly PREVIOUS_BLOCK
PREVIOUS_SHA=$(grep -oE 'reviewed-sha=[0-9a-f]{40}' <<< "$PREVIOUS_BLOCK" | tail -1 | cut -d= -f2 || true)
readonly PREVIOUS_SHA

echo "head_sha=$HEAD_SHA" >> "$GITHUB_OUTPUT"

if [[ -n "$PREVIOUS_SHA" && "$PREVIOUS_SHA" == "$HEAD_SHA" ]]; then
    echo "The review in the PR description already covers $HEAD_SHA, skipping" >&2
    echo "mode=incremental" >> "$GITHUB_OUTPUT"
    echo "skip=true" >> "$GITHUB_OUTPUT"
    exit 0
fi

printf '%s' "$HUMAN_BODY" > "$WORK_DIR/body.md"
jq -r --rawfile body "$WORK_DIR/body.md" '
    "# \(.title)\n",
    "- URL: \(.html_url)",
    "- Author: @\(.user.login)",
    "- Base: \(.base.ref) at \(.base.sha)",
    "- Head: \(.head.label) at \(.head.sha)\n",
    "## Description\n",
    $body
' <<< "$PULL" > "$OUTPUT_DIR/pr.md"

FILES=$(gh api --paginate "/repos/$REPO/pulls/$PR_NUMBER/files" --jq '.[] | {filename, status, additions, deletions, patch}' | jq -s '.')
readonly FILES
printf '%s' "$FILES" > "$WORK_DIR/files.json"
jq -r '.[] | "- \(.status) `\(.filename)` (+\(.additions) -\(.deletions))"' <<< "$FILES" > "$OUTPUT_DIR/changed-files.md"
jq -r '.[] | select(.status != "removed") | .filename' <<< "$FILES" > "$OUTPUT_DIR/head-files.txt"

# The diff media type is refused for very large PRs, so fall back to the per-file patches, which GitHub
# omits only for individual files that are too large or binary.
if ! gh api -H 'Accept: application/vnd.github.diff' "/repos/$REPO/pulls/$PR_NUMBER" > "$OUTPUT_DIR/pr.diff" 2> /dev/null; then
    jq -r '.[] | "diff --git a/\(.filename) b/\(.filename)\n\(.patch // "(patch not available from GitHub, read the file at the PR head)")"' <<< "$FILES" > "$OUTPUT_DIR/pr.diff"
fi

{
    echo "# Conversation comments"
    gh api --paginate "/repos/$REPO/issues/$PR_NUMBER/comments" --jq '.[] | "\n## @\(.user.login) at \(.created_at)\n\n\(.body // "")"'
    echo
    echo "# Review comments on code"
    gh api --paginate "/repos/$REPO/pulls/$PR_NUMBER/comments" --jq '.[] | "\n## @\(.user.login) on \(.path):\(.line // .original_line // "file") at \(.created_at)\n\n\(.body // "")"'
    echo
    echo "# Review summaries"
    gh api --paginate "/repos/$REPO/pulls/$PR_NUMBER/reviews" --jq '.[] | select((.body // "") != "") | "\n## @\(.user.login) \(.state) at \(.submitted_at)\n\n\(.body)"'
} > "$OUTPUT_DIR/comments.md"

# Linked issues give the reviewer the problem the PR is meant to solve. A public PR never gets the
# contents of a private issue, because the review is posted publicly on the PR.
ISSUE_URLS=$(grep -oE 'https://github\.com/Expensify/[A-Za-z0-9_.-]+/issues/[0-9]+' <<< "$HUMAN_BODY" | sort -u | head -n "$MAX_ISSUES" || true)
readonly ISSUE_URLS
{
    echo "# Linked issues"
    if [[ -z "$ISSUE_URLS" ]]; then
        echo
        echo "The PR description links no issues."
    fi
    while IFS= read -r ISSUE_URL; do
        [[ -n "$ISSUE_URL" ]] || continue
        ISSUE_REPO=$(cut -d/ -f4-5 <<< "$ISSUE_URL")
        ISSUE_NUMBER=$(cut -d/ -f7 <<< "$ISSUE_URL")
        echo
        if ! IS_PRIVATE_ISSUE=$(GH_TOKEN="$READ_TOKEN" gh api "/repos/$ISSUE_REPO" --jq '.private' 2> /dev/null); then
            echo "## $ISSUE_URL"
            echo
            echo "Skipped: the reviewer cannot read $ISSUE_REPO."
            continue
        fi
        if [[ "$IS_PUBLIC_REPO" == "true" && "$IS_PRIVATE_ISSUE" == "true" ]]; then
            echo "## $ISSUE_URL"
            echo
            echo "Skipped: the issue is private and this PR is public."
            continue
        fi
        if ! ISSUE_TEXT=$(
            GH_TOKEN="$READ_TOKEN" gh api "/repos/$ISSUE_REPO/issues/$ISSUE_NUMBER" --jq '"## \(.title)\n\n\(.html_url)\n\n\(.body // "")"' &&
                echo &&
                echo "### Issue comments" &&
                GH_TOKEN="$READ_TOKEN" gh api --paginate "/repos/$ISSUE_REPO/issues/$ISSUE_NUMBER/comments" --jq '.[] | "\n#### @\(.user.login) at \(.created_at)\n\n\(.body // "")"'
        ); then
            echo "## $ISSUE_URL"
            echo
            echo "Skipped: the reviewer could not read this issue."
            continue
        fi
        head -c "$MAX_ISSUE_BYTES" <<< "$ISSUE_TEXT"
        echo
    done <<< "$ISSUE_URLS"
} > "$OUTPUT_DIR/issues.md"

if [[ -z "$PREVIOUS_SHA" ]]; then
    echo "mode=first" >> "$GITHUB_OUTPUT"
    echo "skip=false" >> "$GITHUB_OUTPUT"
    exit 0
fi

printf '%s\n' "$PREVIOUS_BLOCK" > "$OUTPUT_DIR/previous-review.md"

# The previous head is an ancestor of the new one unless the branch was force-pushed. GitHub can also
# forget a commit no branch points to any more, which fails the request, and that is a rewrite too.
COMPARISON=$(gh api "/repos/$REPO/compare/$PREVIOUS_SHA...$HEAD_SHA" 2> /dev/null || echo '{"status": "missing"}')
readonly COMPARISON
if [[ "$(jq -r '.status' <<< "$COMPARISON")" != "ahead" ]]; then
    echo "mode=rewritten" >> "$GITHUB_OUTPUT"
    echo "skip=false" >> "$GITHUB_OUTPUT"
    exit 0
fi

# Patches are limited to files the PR still changes. Merging the base branch into the PR brings in
# commits whose files the PR does not touch, and reviewing those would repeat other people's reviews.
{
    echo "# Changes since the last review ($PREVIOUS_SHA...$HEAD_SHA)"
    echo
    echo "## Commits"
    echo
    jq -r '.commits[] | "- \(.sha[0:10]) \(.commit.message | split("\n")[0])\(if (.parents | length) > 1 then " (merge commit)" else "" end)"' <<< "$COMPARISON"
    echo
    echo "## Patches to files this PR changes"
    echo
    jq -r --slurpfile prFiles "$WORK_DIR/files.json" '
        ($prFiles[0] | map(.filename)) as $names
        | .files[]
        | select(.filename as $name | $names | index($name))
        | "diff --git a/\(.filename) b/\(.filename)\n\(.patch // "(patch not available from GitHub, read the file at the PR head)")"
    ' <<< "$COMPARISON"
} > "$OUTPUT_DIR/changes-since-last-review.md"

echo "mode=incremental" >> "$GITHUB_OUTPUT"
echo "skip=false" >> "$GITHUB_OUTPUT"
