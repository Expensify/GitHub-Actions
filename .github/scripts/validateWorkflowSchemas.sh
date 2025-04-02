#!/bin/bash
##########################################################
#    Validate GitHub action and workflow yaml schemas    #
##########################################################

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)"
GITHUB_DIR="$(dirname "$SCRIPT_DIR")"
source "$SCRIPT_DIR/shellUtils.sh"

title 'Validating the Github Actions and workflows using the json schemas provided by (https://www.schemastore.org/json/)'

# Create a temporary directory for schemas
TEMP_SCHEMA_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_SCHEMA_DIR"' EXIT

function download_schema() {
    [[ $1 = 'github-action.json' ]] && SCHEMA_NAME='GitHub Action' || SCHEMA_NAME='GitHub Workflow'
    info "Downloading $SCHEMA_NAME schema..."
    if curl "https://json.schemastore.org/$1" --output "$TEMP_SCHEMA_DIR/$1" --silent; then
        success "Successfully downloaded $SCHEMA_NAME schema!"
        echo
    else
        error "Failed downloading $SCHEMA_NAME schema"
        exit 1
    fi
}

# Download the up-to-date json schemas for github actions and workflows
download_schema 'github-action.json' || exit 1
download_schema 'github-workflow.json' || exit 1

info 'Validating actions and workflows against their JSON schemas...'

# This stores the process IDs of the ajv commands so they can run in parallel
PIDS=()

# Validate the actions and workflows using the JSON schemas and ajv https://github.com/ajv-validator/ajv-cli
for ACTION in "$GITHUB_DIR"/actions/*/*/action.yml; do
    npx ajv -s "$TEMP_SCHEMA_DIR"/github-action.json -d "$ACTION" --strict=false &
    PIDS+=($!)
done
for WORKFLOW in "$GITHUB_DIR"/workflows/*.yml; do
    # Skip linting e2e workflow due to bug here: https://github.com/SchemaStore/schemastore/issues/2579
    if [[ "$WORKFLOW" =~ ^"$GITHUB_DIR"/workflows/(e2ePerformanceTests|testBuild.yml|deploy.yml).yml$ ]]; then
        continue
    fi
    npx ajv -s "$TEMP_SCHEMA_DIR"/github-workflow.json -d "$WORKFLOW" --strict=false &
    PIDS+=($!)
done

# Wait for the background builds to finish
EXIT_CODE=0
for PID in "${PIDS[@]}"; do
    if ! wait "$PID"; then
        EXIT_CODE=1
    fi
done

if [[ $EXIT_CODE == 0 ]]; then
    echo
    success "All actions and workflows are valid"
else
    echo
    error "Some actions and/or workflows are invalid"
fi

exit $EXIT_CODE
