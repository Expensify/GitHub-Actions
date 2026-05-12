#!/bin/bash

# Secure proxy script to remove a reaction from a GitHub PR or Issue.
# Usage: removePrReaction.sh <PR_NUMBER> <REACTION> <USER>
# REACTION: +1, -1, laugh, confused, heart, hooray, rocket, eyes
set -eu

if [[ $# -lt 3 ]]; then
    echo "Usage: $0 <PR_NUMBER> <REACTION> <USER>" >&2
    exit 1
fi

if ! [[ "$1" =~ ^[0-9]+$ ]]; then
    echo "Error: PR_NUMBER must be a positive integer" >&2
    exit 1
fi

case "$2" in
    +1|-1|laugh|confused|heart|hooray|rocket|eyes) ;;
    *)
        echo "Error: REACTION must be one of: +1, -1, laugh, confused, heart, hooray, rocket, eyes" >&2
        exit 1
        ;;
esac

if [[ -z "$3" ]]; then
    echo "Error: USER must be non-empty" >&2
    exit 1
fi

readonly PR_NUMBER="$1"
readonly REACTION="$2"
readonly USER="$3"
readonly REPO="${GITHUB_REPOSITORY}"

ID=$(gh api "/repos/$REPO/issues/$PR_NUMBER/reactions" --jq ".[] | select(.content == \"$REACTION\" and .user.login == \"$USER\") | .id")

if [[ -n "$ID" ]]; then
    gh api --method DELETE "/repos/$REPO/issues/$PR_NUMBER/reactions/$ID"
fi
