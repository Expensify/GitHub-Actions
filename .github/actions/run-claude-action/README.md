# Run Claude Code Action

Composite action that pins [`anthropics/claude-code-action`](https://github.com/anthropics/claude-code-action) to a single SHA shared across `Expensify/App`, `Expensify/Auth`, and `Expensify/Web-Expensify`. Bump the pin here once instead of editing every client `claude-review.yml`.

The composite intentionally stays thin: it sets the common defaults (`display_report`, `allowed_non_write_users`, `--model`) and exposes the upstream `structured_output`. Caller-specific concerns - the `claude-review-toolkit` setup, the eyes-reaction lifecycle, the post-violations loop, and any schema extension - remain in the caller workflow.

## Usage

```yaml
- name: Setup Claude review toolkit
  id: toolkit
  uses: Expensify/GitHub-Actions/.github/actions/claude-review-toolkit@<sha>

- name: Run Claude Code
  id: code-review
  uses: Expensify/GitHub-Actions/.github/actions/run-claude-action@<sha>
  with:
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    github_token: ${{ secrets.GITHUB_TOKEN }}
    prompt: "/review-code-pr REPO: ${{ github.repository }} PR_NUMBER: ${{ github.event.pull_request.number }}"
    claude_args: |
      --allowedTools "Task,Glob,Grep,Read,Bash(gh pr diff:*),Bash(gh pr view:*)" --json-schema '${{ steps.toolkit.outputs.schema_json }}'
```

## Inputs

| Name | Required | Default | Description |
| --- | --- | --- | --- |
| `anthropic_api_key` | yes | - | Anthropic API key. Pass via a caller secret. |
| `github_token` | yes | - | GitHub token used by `claude-code-action`. |
| `prompt` | yes | - | Prompt passed to Claude. Typically the slash command plus PR context (`REPO:`, `PR_NUMBER:`). |
| `model` | no | `claude-opus-4-6` | Model passed via `--model` in `claude_args`. |
| `claude_args` | no | `''` | Caller-specific extra args appended after `--model` (e.g. `--allowedTools`, `--json-schema`). Tools and schemas vary per caller so they live here, not in the composite. |
| `allowed_non_write_users` | no | `*` | Passthrough to `claude-code-action`. |
| `display_report` | no | `true` | Passthrough to `claude-code-action`. |

## Outputs

| Name | Description |
| --- | --- |
| `structured_output` | Passthrough of `claude-code-action.outputs.structured_output`. Callers parse this for the post-violations loop. |

## Bumping the pin

Update the `uses:` line in `action.yml` to the new SHA and version tag comment. Client workflows automatically pick up the new pin on the next merge that floats their `Expensify/GitHub-Actions/...@<sha>` reference forward.
