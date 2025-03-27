#!/bin/bash

source "$(dirname "${BASH_SOURCE[0]}")/shellUtils.sh"

###############################################################################
#                        Validate json scehmas with ajv                       #
###############################################################################
title 'Validating the Github Actions and workflows using the json schemas provided by (https://www.schemastore.org/json/)'

function downloadSchema {
  [[ $1 = 'github-action.json' ]] && SCHEMA_NAME='GitHub Action' || SCHEMA_NAME='GitHub Workflow'
  info "Downloading $SCHEMA_NAME schema..."
  if curl "https://json.schemastore.org/$1" --output "./tempSchemas/$1" --silent; then
    success "Successfully downloaded $SCHEMA_NAME schema!"
  else
    error "Failed downloading $SCHEMA_NAME schema"
    exit 1
  fi
}

# Download the up-to-date json schemas for github actions and workflows
cd ./.github && mkdir ./tempSchemas || exit 1
downloadSchema 'github-action.json' || exit 1
downloadSchema 'github-workflow.json' || exit 1

# Track exit codes separately so we can run a full validation, report errors, and exit with the correct code
declare EXIT_CODE=0

# This stores all the process IDs of the ajv commands so they can run in parallel
declare ASYNC_PROCESSES

# Arrays of actions and workflows
declare -r ACTIONS=(./actions/*/*/action.yml)
declare -r WORKFLOWS=(./workflows/*.yml)

info 'Validating actions and workflows against their JSON schemas...'

# Validate the actions and workflows using the JSON schemas and ajv https://github.com/ajv-validator/ajv-cli
for ((i=0; i < ${#ACTIONS[@]}; i++)); do
  ACTION=${ACTIONS[$i]}
  npx ajv -s ./tempSchemas/github-action.json -d "$ACTION" --strict=false &
  ASYNC_PROCESSES[i]=$!
done

for ((i=0; i < ${#WORKFLOWS[@]}; i++)); do
  WORKFLOW=${WORKFLOWS[$i]}

  # Skip linting e2e workflow due to bug here: https://github.com/SchemaStore/schemastore/issues/2579
  if [[ "$WORKFLOW" == './workflows/e2ePerformanceTests.yml'
        || "$WORKFLOW" == './workflows/testBuild.yml'
        || "$WORKFLOW" == './workflows/deploy.yml' ]]; then
    continue
  fi

  npx ajv -s ./tempSchemas/github-workflow.json -d "$WORKFLOW" --strict=false &
  ASYNC_PROCESSES[${#ACTIONS[@]} + i]=$!
done

# Wait for the background builds to finish
for PID in "${ASYNC_PROCESSES[@]}"; do
  wait "$PID"
  RESULT=$?
  if [[ $RESULT != 0 ]]; then
    EXIT_CODE=$RESULT
  fi
done

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

# Loop through them, looking for action usages
actionUsages=''
while IFS= read -r yamlFile; do
    # Search for uses: in the yaml file
    usesLines="$(grep --no-filename 'uses:' "$yamlFile")"

    # Ignore files without external action usages
    if [[ -z "$usesLines" ]]; then
        continue
    fi

    # Normalize: remove leading -
    usesLines="${usesLines//- uses:/uses:}"

    # Normalize: remove quotes
    usesLines="${usesLines//\"/ }"
    usesLines="${usesLines//\'/ }"

    # Normalize: remove carriage returns
    usesLines="${usesLines//\\r/ }"

    # Normalize: trim whitespace
    usesLines="$(echo "$usesLines" | awk '{print $2}')"

    actionUsages+="$usesLines"$'\n'
done <<< "$yamlFiles"

# De-dupe and sort action usages
actionUsages="$(echo "$actionUsages" | sort | uniq)"

info 'All action usages...'
echo "$actionUsages"
echo

# Ignore any local action usages, callable workflows, or Expensify-owned actions
actionUsages="$(echo "$actionUsages" | grep -vE "^(.github|Expensify/)")"

info 'Untrusted action usages...'
echo "$actionUsages"
echo

GIT_HASH_REGEX='\b[0-9a-f]{40}\b'
grep -vE "$GIT_HASH_REGEX" /tmp/untrustedActionUsages.txt > /tmp/unsafeActionUsages.txt
if [ -s /tmp/unsafeActionUsages.txt ]; then
  echo ''
  error 'Found unsafe mutable action reference to an untrusted action. Use an immutable commit hash reference instead'
  cat /tmp/unsafeActionUsages.txt
  EXIT_CODE=1
fi

if [[ "$EXIT_CODE" == 0 ]]; then
  success '✅ All untrusted actions are using immutable references'
fi

exit $EXIT_CODE
