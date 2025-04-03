#!/bin/bash
############################################
#    Check for unsafe action references    #
############################################

GITHUB_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." &>/dev/null && pwd)"
readonly GITHUB_DIR

source "$GITHUB_DIR/scripts/shellUtils.sh"

title 'Checking for mutable action references...'

ACTION_USAGES=''

# Find yaml files - these can be either:
# - workflows, which are always stored in .github/workflows, or
YAML_FILES="$(find "$GITHUB_DIR/workflows" -type f \( -name "*.yml" -o -name "*.yaml" \))"
# - action metadata files, which can be anywhere in the repo, but must be called action.yml or action.yaml
YAML_FILES+=" $(find "$GITHUB_DIR/.." -type f \( -name "action.yml" -o -name "action.yaml" \))"

# Find yaml files in the `.github` directory
for FILE in $YAML_FILES; do
    USES_LINES="$(grep 'uses:' "$FILE")"

    # Ignore files without external action usages
    if [[ -z "$USES_LINES" ]]; then
        continue
    fi

    # Normalize: remove leading -
    USES_LINES="${USES_LINES//- uses:/uses:}"

    # Normalize: remove quotes
    USES_LINES="${USES_LINES//\"/ }"
    USES_LINES="${USES_LINES//\'/ }"

    # Normalize: remove carriage returns
    USES_LINES="${USES_LINES//\\r/ }"

    # Grab action names and refs from uses lines.
    # At this point, these lines look like "uses: myAction@ref", so `awk '{print $2}'` just grabs the second word from each line.
    ACTION_USAGES+=$'\n'
    ACTION_USAGES+="$(echo "$USES_LINES" | awk '{print $2}')"
done

# De-dupe and sort action usages
ACTION_USAGES="$(echo "$ACTION_USAGES" | grep -vE '^$' | sort | uniq)"

info 'All action usages...'
echo "$ACTION_USAGES"
echo

# Ignore any local action usages, callable workflows, or Expensify-owned actions
# Examples:
#    - uses: ./.github/workflows/myCallableWorkflow.yml
#    - uses: .github/workflows/myCallableWorkflow.yml
#    - uses: .github/actions/composite/myCompositeAction.yml
#    - uses: Expensify/GitHub-Actions/setupGitForOSBotify@main
ACTION_USAGES="$(echo "$ACTION_USAGES" | grep -vE "^((./)?.github|Expensify/)")"

# Next, we'll check all the untrusted actions we found to make sure they're immutable
info 'Untrusted action usages...'
echo "$ACTION_USAGES"
echo

# Given an action and ref, check the remote repo to make sure the ref is not a tag or branch
function check_remote_ref() {
    local ACTION="$1"
    local REF="$2"

    # The repo is everything in the action until the second slash (if one exists)
    # Typically actions look like actions/checkout, but they can contain nested directories like gradle/actions/setup-gradle
    # In that case, the repo is just gradle/actions
    local REPO
    REPO="$(echo "$ACTION" | awk -F/ '{print $1 "/" $2}')"

    local REPO_URL="git@github.com:${REPO}.git"
    if git ls-remote --quiet --tags --heads --exit-code "$REPO_URL" "refs/*/$REF*" ; then
        error "Found remote branch or tag that looks like a commit hash! ${ACTION}@${REF}"
        return 1
    fi
}

MUTABLE_ACTION_USAGES=""
PIDS=()
for ACTION_USAGE in $(echo -e "$ACTION_USAGES") ; do
    # Given an action usage like actions/checkout@v4, get:
    # everything before the @
    ACTION="${ACTION_USAGE%@*}"
    # and everything after the @
    REF="${ACTION_USAGE##*@}"

    # Check if the ref looks like a commit hash (40-character hexadecimal string)
    if [[ ! "$REF" =~ ^[0-9a-f]{40}$ ]]; then
        # Ref does not look like a commit hash, and therefore is probably mutable
        MUTABLE_ACTION_USAGES+="$ACTION_USAGE\n"
        continue
    fi

    # Check the remote to make sure the 40-character hex ref is not secretly a branch or tag
    # Do this in the background because it's slow
    check_remote_ref "$ACTION" "$REF" &
    PIDS+=($!)
done

EXIT_CODE=0
for PID in "${PIDS[@]}" ; do
    if ! wait "$PID" ; then
        EXIT_CODE=1
    fi
done

if [[ -n "$MUTABLE_ACTION_USAGES" || $EXIT_CODE -ne 0 ]]; then
    error 'The following actions use unsafe mutable references; use an immutable commit hash reference instead!'
    echo -e "$MUTABLE_ACTION_USAGES"
    exit 1
fi

success '✅ All untrusted actions are using immutable references'
