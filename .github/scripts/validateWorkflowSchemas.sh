#!/bin/bash
##########################################################
#    Validate GitHub action and workflow yaml schemas    #
##########################################################

GITHUB_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." &>/dev/null && pwd)"
readonly GITHUB_DIR

source "$GITHUB_DIR/scripts/shellUtils.sh"

title 'Validating the Github Actions and workflows using the json schemas provided by (https://www.schemastore.org/json/)'

# Create a temporary directory for schemas
TEMP_SCHEMA_DIR="$(mktemp -d)"
readonly TEMP_SCHEMA_DIR
trap 'rm -rf "$TEMP_SCHEMA_DIR"' EXIT

# Download the up-to-date json schemas for github actions and workflows
readonly SCHEMAS_TO_DOWNLOAD=('github-action.json' 'github-workflow.json')
for SCHEMA in "${SCHEMAS_TO_DOWNLOAD[@]}"; do
    info "Downloading $SCHEMA schema..."
    if curl "https://json.schemastore.org/$SCHEMA" --output "$TEMP_SCHEMA_DIR/$SCHEMA" --silent; then
        success "Successfully downloaded $SCHEMA schema!"
        echo
    else
        error "Failed downloading $SCHEMA schema"
        exit 1
    fi
done

info 'Validating actions and workflows against their JSON schemas...'

# This stores the process IDs of the ajv commands so they can run in parallel
PIDS=()

# Validate the actions and workflows using the JSON schemas and ajv https://github.com/ajv-validator/ajv-cli
# shellcheck disable=SC2044
for ACTION in $(find "$GITHUB_DIR/actions" -type f \( -name "*.yml" -o -name "*.yaml" \)); do
    npx ajv -s "$TEMP_SCHEMA_DIR"/github-action.json -d "$ACTION" --strict=false &
    PIDS+=($!)
done
# shellcheck disable=SC2044
for WORKFLOW in $(find "$GITHUB_DIR/workflows" -type f \( -name "*.yml" -o -name "*.yaml" \)); do
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

echo
if [[ $EXIT_CODE -ne 0 ]]; then
    error "Some actions and/or workflows are invalid"
    exit $EXIT_CODE
fi

success "All actions and workflows are valid"
