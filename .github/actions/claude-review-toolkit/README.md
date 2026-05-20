# Claude Review Toolkit

Composite action that ships the shared scaffolding for the Claude PR review pipeline used by `Expensify/App`, `Expensify/Auth`, and `Expensify/Web-Expensify`.

It places a set of helper scripts on `GITHUB_PATH`, exposes the canonical violations-only JSON schema as both a file and a compacted string, and enforces a per-comment rule-ID security gate on inline comments.

## Usage

```yaml
- name: Setup Claude review toolkit
  id: toolkit
  uses: Expensify/GitHub-Actions/.github/actions/claude-review-toolkit@<sha>

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

Caller repos must ship a `.claude/skills/coding-standards/rules/` directory with at least one `.md` rule file whose YAML frontmatter declares a `ruleId:` tag matching `[A-Z]+(-[A-Z]+)*-[0-9]+` (e.g. `PERF-1`, `GEN-01`, `CLEAN-REACT-PATTERNS-0`). The action's extract step builds an allowlist from those tags and fails the workflow if the directory is missing or yields no tags.

## Outputs

| Name | Description |
| --- | --- |
| `schema_path` | Absolute filesystem path to `schemas/code-review-output.json` (the canonical violations-only schema). |
| `schema_json` | Same schema compacted as a single-line JSON string, ready to pass to `claude-code-action --json-schema`. Callers that need a repo-specific extension (e.g. Auth's `missingQueryTimings` flag) can `jq`-merge on top of this value in a subsequent step rather than forking the schema. |

## Side effects

- Prepends `<action-path>/scripts` to `GITHUB_PATH`, so the helper scripts below are callable by bare name in later steps.
- Exports `ALLOWED_RULES_FILE` to `$GITHUB_ENV`, pointing at the deduplicated allowlist extracted from the caller's rules directory.

## Scripts on `PATH`

| Script | Signature | Notes |
| --- | --- | --- |
| `addPrReaction.sh` | `<PR_NUMBER> <REACTION>` | Adds a reaction (`+1`, `-1`, `laugh`, `confused`, `heart`, `hooray`, `rocket`, `eyes`) to the PR. |
| `removePrReaction.sh` | `<PR_NUMBER> <REACTION> <USER>` | Removes the matching reaction authored by `<USER>` (typically `github-actions[bot]`). Idempotent. |
| `createInlineComment.sh` | `<PR_NUMBER> <path> <body> <line>` | Posts an inline review comment. Requires `GITHUB_REPOSITORY`, `GH_TOKEN`, and `ALLOWED_RULES_FILE` in env. The body must reference a rule tag matching `[A-Z]+(-[A-Z]+)*-[0-9]+` (e.g. `PERF-1`) that is present in the allowlist; otherwise the comment is rejected. |
| `extractAllowedRules.sh` | `<rules-dir> <output-file>` | Walks `<rules-dir>` for `.md` rule files and writes their `ruleId:` tags to `<output-file>`. Invoked automatically by the action; rarely called directly. |

## Schema extension

Repos that need extra fields on top of the canonical schema should `jq`-merge them in a follow-up step before feeding `claude_args`. Read the canonical schema from `schema_path` (a file) rather than piping `schema_json` through `echo`, so the shell never sees the schema's `"` characters:

```yaml
- name: Extend schema
  id: schema
  env:
    SCHEMA_PATH: ${{ steps.toolkit.outputs.schema_path }}
  run: |
    EXTENDED=$(jq -c '.properties.missingQueryTimings = {"type":"boolean"} | .required += ["missingQueryTimings"]' "$SCHEMA_PATH")
    echo "json=$EXTENDED" >> "$GITHUB_OUTPUT"
```

Keep extensions narrow - the canonical schema stays the source of truth for the violations array shared across all reviewers.

> [!WARNING]
> Do **not** consume `schema_json` from a shell step via `echo "${{ steps.toolkit.outputs.schema_json }}"`. GitHub Actions interpolates the expression before bash parses the line, and the schema's inner `"` characters terminate the surrounding shell string - `jq` then sees mangled input and exits with a parse error. Use the `schema_path` form above for any `jq`/shell manipulation; reserve `schema_json` for the single-quoted `claude_args:` form shown in [Usage](#usage), where the action's argv parser handles it correctly.
