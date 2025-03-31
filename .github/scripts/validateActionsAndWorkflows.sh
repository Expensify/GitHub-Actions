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
  if [[ "$OSTYPE" != 'darwin'* || -z "$(command -v brew)" ]]; then
    echo 'This script requires shellcheck to be installed. Please install it and try again'
    exit 1
  fi

  brew install shellcheck
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
yamlFiles="$(find . -type f \( -name "*.yml" -o -name "*.yaml" \))"

# Parse a yaml file, looking for action usages
# Disabling shellcheck because this function is invoked by name and is reachable
# shellcheck disable=SC2317
extractActionsFromYaml() {
  # Search for "uses:" in the yaml file
  local usesLines
  usesLines="$(grep --no-filename 'uses:' "$1")"

  # Ignore files without external action usages
  if [[ -z "$usesLines" ]]; then
    return 0
  fi

  # Normalize: remove leading -
  usesLines="${usesLines//- uses:/uses:}"

  # Normalize: remove quotes
  usesLines="${usesLines//\"/ }"
  usesLines="${usesLines//\'/ }"

  # Normalize: remove carriage returns
  usesLines="${usesLines//\\r/ }"

  # Grab action names and refs from uses lines.
  # At this point, these lines look like "uses: myAction@ref", so `awk '{print $2}'` just grabs the second word from each line.
  local actionsWithRefs
  actionsWithRefs="$(echo "$usesLines" | awk '{print $2}')"
  echo "$actionsWithRefs"
  echo $'\n'
}

# Parse all yaml files in parallel to find all action usages
while IFS= read -r yamlFile; do
  run_async extractActionsFromYaml "$yamlFile"
done <<< "$yamlFiles"
actionUsages="$(await_async_commands)"

# De-dupe and sort action usages
actionUsages="$(echo "$actionUsages" | grep -vE '^$' | sort | uniq)"

info 'All action usages...'
echo "$actionUsages"
echo

# Ignore any local action usages, callable workflows, or Expensify-owned actions
actionUsages="$(echo "$actionUsages" | grep -vE "^(.github|Expensify/)")"

info 'Untrusted action usages...'
echo "$actionUsages"
echo

# Next, we'll check all the actions we found to make sure they're immutable.
# We're using a temp file instead of a variable so that we aggregate mutable action usages across several async subprocesses.
mutableActionUsages="$(mktemp)"

# Given an action name with a ref, check the actual repo to make sure it's an immutable commit hash
# and not secretly a tag or branch that looks like a commit hash.
# If it's mutable, collect it into the mutableActionUsages file.
# shellcheck disable=SC2317
verifyActionRefIsImmutable() {
  local actionWithRef="$1"

  # Everything before the @
  local action
  action="${1%@*}"

  # Everything after the @
  local ref
  ref="${1##*@}"

  # Check if the ref looks like a commit hash (40-character hexadecimal string)
  if [[ ! "$ref" =~ ^[0-9a-f]{40}$ ]]; then
    # Ref does not look like a commit hash, and therefore is probably mutable
    echo "$actionWithRef" >> "$mutableActionUsages"
    return 1
  fi

  # Ref looks like a commit hash, but we need to check the remote to make sure it's not a tag or a branch
  local repoURL
  repoURL="git@github.com:${action}.git"

  # Check if the ref exists in the remote as a branch or tag
  if git ls-remote --quiet --tags --exit-code "$repoURL" "refs/*/$ref*"; then
    error "Found remote branch or tag that looks like a commit hash! $actionWithRef"
    echo
    echo "$actionWithRef" >> "$mutableActionUsages"
    return 1
  fi

  # If we get here, the action is immutable
  return 0
}

while IFS= read -r actionWithRef; do
  run_async verifyActionRefIsImmutable "$actionWithRef"
done <<< "$actionUsages"
await_async_commands

if [[ -s "$mutableActionUsages" ]]; then
  error 'The following actions use unsafe mutable references; use an immutable commit hash reference instead!'
  cat "$mutableActionUsages"
  EXIT_CODE=1
fi

if [[ "$EXIT_CODE" == 0 ]]; then
  success '✅ All untrusted actions are using immutable references'
fi

rm -f "$mutableActionUsages"
cleanup_async

exit $EXIT_CODE
