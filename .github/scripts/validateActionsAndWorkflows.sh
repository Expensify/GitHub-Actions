#!/bin/bash

source "$(dirname "${BASH_SOURCE[0]}")/utils/async.sh"
source "$(dirname "${BASH_SOURCE[0]}")/utils/shellUtils.sh"

###############################################################################
#                        Validate json scehmas with ajv                       #
###############################################################################
title 'Validating the Github Actions and workflows using the json schemas provided by (https://www.schemastore.org/json/)'

# Disabling shellcheck because this function is invoked by name
# shellcheck disable=SC2317
function downloadSchema {
    [[ $1 = 'github-action.json' ]] && SCHEMA_NAME='GitHub Action' || SCHEMA_NAME='GitHub Workflow'
    info "Downloading $SCHEMA_NAME schema..."
    if curl "https://json.schemastore.org/$1" --output "./tempSchemas/$1" --silent; then
        success "Successfully downloaded $SCHEMA_NAME schema!"
        echo
    else
        error "Failed downloading $SCHEMA_NAME schema"
        exit 1
    fi
}

# Download the up-to-date json schemas for github actions and workflows
cd ./.github && mkdir ./tempSchemas || exit 1
run_async downloadSchema 'github-action.json' || exit 1
run_async downloadSchema 'github-workflow.json' || exit 1
await_async_commands

# Track exit codes separately so we can run a full validation, report errors, and exit with the correct code
declare EXIT_CODE=0

info 'Validating actions and workflows against their JSON schemas...'

# Validate the actions and workflows using the JSON schemas and ajv https://github.com/ajv-validator/ajv-cli
for ACTION in ./actions/*/*/action.yml; do
    run_async npx ajv -s ./tempSchemas/github-action.json -d "$ACTION" --strict=false
done

for WORKFLOW in ./workflows/*.yml; do
    # Skip linting e2e workflow due to bug here: https://github.com/SchemaStore/schemastore/issues/2579
    if [[ "$WORKFLOW" =~ ^./workflows/(e2ePerformanceTests|testBuild.yml|deploy.yml).yml$ ]]; then
        continue
    fi
    run_async npx ajv -s ./tempSchemas/github-workflow.json -d "$WORKFLOW" --strict=false
done

# Wait for the background builds to finish
await_async_commands

# Cleanup after ourselves and delete the schemas
rm -rf ./tempSchemas

###############################################################################
#                            Lint with actionlint                             #
###############################################################################
title 'Lint Github Actions via actionlint (https://github.com/rhysd/actionlint)'

# If we are running this on a non-CI machine (e.g. locally), install shellcheck
if [[ -z "${CI}" && -z "$(command -v shellcheck)" ]]; then
    echo 'This script requires shellcheck to be installed. Please install it and try again'
    exit 1
fi

info 'Downloading actionlint...'
if bash <(curl --silent https://raw.githubusercontent.com/rhysd/actionlint/main/scripts/download-actionlint.bash); then
    success 'Successfully downloaded actionlint!'
    echo
else
    error 'Error downloading actionlint'
    exit 1
fi

info 'Linting workflows...'
./actionlint -color || EXIT_CODE=1
if [[ "$EXIT_CODE" == 0 ]]; then
    success 'Workflows passed actionlint!'
fi

# Cleanup after ourselves and delete actionlint
rm -rf ./actionlint

###############################################################################
#                      Check for unsafe action references                     #
###############################################################################
title 'Checking for mutable action references...'

# Find yaml files in the `.github` directory
YAML_FILES="$(find . -type f \( -name "*.yml" -o -name "*.yaml" \))"

# Parse a yaml file, looking for action usages
# Disabling shellcheck because this function is invoked by name and is reachable
# shellcheck disable=SC2317
extractActionsFromYaml() {
    # Search for "uses:" in the yaml file
    local USES_LINES
    USES_LINES="$(grep --no-filename 'uses:' "$1")"

    # Ignore files without external action usages
    if [[ -z "$USES_LINES" ]]; then
        return 0
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
    local ACTIONS_WITH_REFS
    ACTIONS_WITH_REFS="$(echo "$USES_LINES" | awk '{print $2}')"
    echo "$ACTIONS_WITH_REFS"
    echo $'\n'
}

# Parse all yaml files in parallel to find all action usages
while IFS= read -r YAML_FILE; do
    run_async extractActionsFromYaml "$YAML_FILE"
done <<< "$YAML_FILES"
ACTION_USAGES="$(await_async_commands)"

# De-dupe and sort action usages
ACTION_USAGES="$(echo "$ACTION_USAGES" | grep -vE '^$' | sort | uniq)"

info 'All action usages...'
echo "$ACTION_USAGES"
echo

# Ignore any local action usages, callable workflows, or Expensify-owned actions
ACTION_USAGES="$(echo "$ACTION_USAGES" | grep -vE "^(.github|Expensify/)")"

info 'Untrusted action usages...'
echo "$ACTION_USAGES"
echo

# Next, we'll check all the actions we found to make sure they're immutable.
# We're using a temp file instead of a variable so we can write to it from a subprocess (i.e: a command run in the background)
MUTABLE_ACTION_USAGES="$(mktemp)"

# Given an action name with a ref (actions/checkout@v2), check the actual repo to make sure it's an immutable commit hash
# and not secretly a tag or branch that looks like a commit hash.
# If it's mutable, collect it into the MUTABLE_ACTION_USAGES file.
# shellcheck disable=SC2317
verifyActionRefIsImmutable() {
    local ACTIONS_WITH_REFS="$1"

    # Everything before the @
    local ACTION="${1%@*}"

    # Everything after the @
    local REF="${1##*@}"

    # Check if the ref looks like a commit hash (40-character hexadecimal string)
    if [[ ! "$REF" =~ ^[0-9a-f]{40}$ ]]; then
        # Ref does not look like a commit hash, and therefore is probably mutable
        echo "$ACTIONS_WITH_REFS" >> "$MUTABLE_ACTION_USAGES"
        return 1
    fi

    # Ref looks like a commit hash, but we need to check the remote to make sure it's not a tag or a branch
    local REPO_URL="git@github.com:${ACTION}.git"

    # Check if the ref exists in the remote as a branch or tag
    if git ls-remote --quiet --tags --branches --exit-code "$REPO_URL" "refs/*/$REF*"; then
        error "Found remote branch or tag that looks like a commit hash! $ACTIONS_WITH_REFS"
        echo
        echo "$ACTIONS_WITH_REFS" >> "$MUTABLE_ACTION_USAGES"
        return 1
    fi

    # If we get here, the action is immutable
    return 0
}

while IFS= read -r ACTIONS_WITH_REFS; do
    run_async verifyActionRefIsImmutable "$ACTIONS_WITH_REFS"
done <<< "$ACTION_USAGES"
await_async_commands

if [[ -s "$MUTABLE_ACTION_USAGES" ]]; then
    error 'The following actions use unsafe mutable references; use an immutable commit hash reference instead!'
    cat "$MUTABLE_ACTION_USAGES"
    EXIT_CODE=1
fi

if [[ "$EXIT_CODE" == 0 ]]; then
    success '✅ All untrusted actions are using immutable references'
fi

rm -f "$MUTABLE_ACTION_USAGES"
cleanup_async

exit $EXIT_CODE
