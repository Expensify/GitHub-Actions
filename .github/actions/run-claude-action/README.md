# Run Claude Code Action

Composite action that pins [`anthropics/claude-code-action`](https://github.com/anthropics/claude-code-action) to a single SHA shared across `Expensify/App`, `Expensify/Auth`, and `Expensify/Web-Expensify`. Bump the pin here once instead of editing every client `claude-review.yml`.

The composite intentionally stays thin: it sets the common defaults (`display_report`, `allowed_non_write_users`) and exposes the upstream `structured_output`. The model, allowed tools, and JSON schema vary per caller and live in `claude_args`. Caller-specific concerns - the `claude-review-toolkit` setup, the eyes-reaction lifecycle, the post-violations loop, and any schema extension - remain in the caller workflow.

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
      --model claude-opus-4-6
      --allowedTools "Task,Glob,Grep,Read,Bash(gh pr diff:*),Bash(gh pr view:*)" --json-schema '${{ steps.toolkit.outputs.schema_json }}'
```

If you omit `--model`, `claude-code-action` uses its own default (currently Sonnet). Pass `--model claude-opus-4-6` (or whichever model you want) explicitly to lock the choice.

## Inputs

| Name | Required | Default | Description |
| --- | --- | --- | --- |
| `anthropic_api_key` | yes | - | Anthropic API key. Pass via a caller secret. |
| `github_token` | yes | - | GitHub token used by `claude-code-action`. |
| `prompt` | yes | - | Prompt passed to Claude. Typically the slash command plus PR context (`REPO:`, `PR_NUMBER:`). |
| `claude_args` | no | `''` | Forwarded verbatim to `claude-code-action.claude_args`. Put `--model`, `--allowedTools`, `--json-schema`, etc. here. Model selection lives caller-side because today's three client repos disagree (App: Opus; Auth/Web: CLI default). |
| `allowed_non_write_users` | no | `*` | Passthrough to `claude-code-action`. |
| `display_report` | no | `true` | Passthrough to `claude-code-action`. |

## Outputs

| Name | Description |
| --- | --- |
| `structured_output` | Passthrough of `claude-code-action.outputs.structured_output`. Callers parse this for the post-violations loop. |

## Bumping the pin

Update the `uses:` line in `action.yml` to the new SHA and version tag comment. Client workflows automatically pick up the new pin on the next merge that floats their `Expensify/GitHub-Actions/...@<sha>` reference forward.
