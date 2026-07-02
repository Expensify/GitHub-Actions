#!/bin/bash

# Secure proxy script to add a reaction to a GitHub PR or Issue.
# Usage: addPrReaction.sh <PR_NUMBER> <REACTION>
# REACTION: +1, -1, laugh, confused, heart, hooray, rocket, eyes
set -eu

if [[ $# -lt 2 ]]; then
    echo "Usage: $0 <PR_NUMBER> <REACTION>" >&2
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

readonly PR_NUMBER="$1"
readonly REACTION="$2"
readonly REPO="${GITHUB_REPOSITORY}"

gh api -X POST "/repos/$REPO/issues/$PR_NUMBER/reactions" -f content="$REACTION"
