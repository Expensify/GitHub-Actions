#!/bin/bash
##########################################################
#    Validate GitHub action and workflow yaml schemas    #
##########################################################

GITHUB_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." &>/dev/null && pwd)"
readonly GITHUB_DIR

source "$GITHUB_DIR/scripts/shellUtils.sh"

title "Validating the Github Actions and workflows using the json schemas provided by (https://www.schemastore.org/json/)"

# Create a temporary directory for schemas
TEMP_SCHEMA_DIR="$(mktemp -d)"
readonly TEMP_SCHEMA_DIR
trap 'rm -rf "$TEMP_SCHEMA_DIR"' EXIT

# Download the up-to-date json schemas for github actions and workflows
for SCHEMA in github-action.json github-workflow.json; do
    info "Downloading $SCHEMA schema..."
    if curl "https://json.schemastore.org/$SCHEMA" --output "$TEMP_SCHEMA_DIR/$SCHEMA" --silent; then
        success "Successfully downloaded $SCHEMA schema!"
    else
        error "Failed downloading $SCHEMA schema"
        exit 1
    fi
done

EXIT_CODE=0

echo
info "Validating action metadata files against their JSON schema..."
echo

# Get all actions, delimited by -d (data arg for ajv)
ACTIONS="$(find "$GITHUB_DIR/.." -type f \( -name "action.yml" -o -name "action.yaml" \) -exec echo -n " -d "{} \;)"

# Disabling shellcheck because we WANT word-splitting on ACTIONS in this case
# shellcheck disable=SC2086
if ! npx ajv --strict=false -s "$TEMP_SCHEMA_DIR"/github-action.json $ACTIONS; then
    EXIT_CODE=1
fi

echo
info "Validating workflows against their JSON schema..."
echo

# Get all workflows, delimited by -d (data arg for ajv)
WORKFLOWS="$(find "$GITHUB_DIR/workflows" -type f \( -name "*.yml" -o -name "*.yaml" \) -exec echo -n " -d "{} \;)"\

# shellcheck disable=SC2086
if ! npx ajv --strict=false -s "$TEMP_SCHEMA_DIR"/github-workflow.json $WORKFLOWS; then
    EXIT_CODE=1
fi

echo

if [[ $EXIT_CODE -ne 0 ]]; then
    error "Some actions and/or workflows are invalid"
    exit $EXIT_CODE
fi

success "All actions and workflows are valid"
