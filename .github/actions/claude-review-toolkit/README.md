# Claude Review Toolkit

Composite action that ships the shared scaffolding for the Claude PR review pipeline used by `Expensify/App`, `Expensify/Auth`, and `Expensify/Web-Expensify`.

It places a set of helper scripts on `GITHUB_PATH`, exposes the canonical violations-only JSON schema as both a file and a compacted string, and optionally enables a per-comment rule-ID security gate.

## Usage

```yaml
- name: Setup Claude review toolkit
  id: toolkit
  uses: Expensify/GitHub-Actions/.github/actions/claude-review-toolkit@<sha>
  with:
    enforce_allowed_rules: 'true'  # optional; default 'false'

- name: Run Claude Code
  uses: anthropics/claude-code-action@<sha>
  with:
    claude_args: |
      --json-schema '${{ steps.toolkit.outputs.schema_json }}'

- name: Post inline comment
  env:
    GH_TOKEN: ${{ github.token }}
  run: createInlineComment.sh "${{ github.event.pull_request.number }}" "src/foo.ts" "PERF-1: ..." 42
```

## Inputs

| Name | Default | Description |
| --- | --- | --- |
| `enforce_allowed_rules` | `false` | When `true`, walks `.claude/skills/coding-standards/rules/` in the caller's workspace, writes a deduplicated allowlist to `$RUNNER_TEMP/allowed-rules.txt`, and exports `ALLOWED_RULES_FILE` so `createInlineComment.sh` enforces a per-comment rule-ID gate. Today only `Expensify/App` opts in; `Auth` and `Web-Expensify` run without the gate. |

## Outputs

| Name | Description |
| --- | --- |
| `schema_path` | Absolute filesystem path to `schemas/code-review-output.json` (the canonical violations-only schema). |
| `schema_json` | Same schema compacted as a single-line JSON string, ready to pass to `claude-code-action --json-schema`. Callers that need a repo-specific extension (e.g. Auth's `missingQueryTimings` flag) can `jq`-merge on top of this value in a subsequent step rather than forking the schema. |

## Side effects

- Prepends `<action-path>/scripts` to `GITHUB_PATH`, so the helper scripts below are callable by bare name in later steps.
- When `enforce_allowed_rules: 'true'`, exports `ALLOWED_RULES_FILE` to `$GITHUB_ENV`.

## Scripts on `PATH`

| Script | Signature | Notes |
| --- | --- | --- |
| `addPrReaction.sh` | `<PR_NUMBER> <REACTION>` | Adds a reaction (`+1`, `-1`, `laugh`, `confused`, `heart`, `hooray`, `rocket`, `eyes`) to the PR. |
| `removePrReaction.sh` | `<PR_NUMBER> <REACTION> <USER>` | Removes the matching reaction authored by `<USER>` (typically `github-actions[bot]`). Idempotent. |
| `createInlineComment.sh` | `<PR_NUMBER> <path> <body> <line>` | Posts an inline review comment. Requires `GITHUB_REPOSITORY` and `GH_TOKEN` in env. When `ALLOWED_RULES_FILE` is set and non-empty, the body must reference a rule tag matching `[A-Z]+(-[A-Z]+)*-[0-9]+` (e.g. `PERF-1`) that is present in the allowlist; otherwise the comment is rejected. When unset, validation is skipped. |
| `extractAllowedRules.sh` | `<rules-dir> <output-file>` | Walks `<rules-dir>` for `.md` rule files and writes their rule-ID tags to `<output-file>`. Invoked automatically by the action when `enforce_allowed_rules: 'true'`; rarely called directly. |

## Schema extension

Repos that need extra fields on top of the canonical schema should `jq`-merge them in a follow-up step before feeding `claude_args`:

```yaml
- name: Extend schema
  id: schema
  run: |
    EXTENDED=$(echo "${{ steps.toolkit.outputs.schema_json }}" \
      | jq -c '.properties.missingQueryTimings = {"type":"boolean"} | .required += ["missingQueryTimings"]')
    echo "json=$EXTENDED" >> "$GITHUB_OUTPUT"
```

Keep extensions narrow - the canonical schema stays the source of truth for the violations array shared across all reviewers.
