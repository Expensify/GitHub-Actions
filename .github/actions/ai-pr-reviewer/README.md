# AI PR Reviewer

Composite action that reviews a pull request with the [`pr-review-walkthrough`](https://github.com/Expensify/llm-skills-library/tree/main/plugins/expensi-skills-engineer/skills/pr-review-walkthrough) skill and keeps the result in a collapsed block at the bottom of the PR description:

```
<details>
<summary>Expensify AI reviewer: ❌ Changes requested (2 blocking, 3 suggestions)</summary>
...verdict, blocking changes, UX, testing, suggestions, file-by-file walkthrough...
</details>
```

The verdict is ✅ Approved exactly when no blocking finding is open. The coding-standards reviewer in `claude-review-toolkit` still handles style; this one checks whether the PR is correct, solves its issue and is tested.

## Usage

Run it on every push so the review follows the PR. It does not wait for other reviewers.

```yaml
on:
  pull_request_target:
    types: [opened, ready_for_review, synchronize]

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    if: github.event.pull_request.draft == false
    concurrency:
      group: ai-pr-reviewer-${{ github.event.pull_request.html_url }}
      cancel-in-progress: true
    runs-on: blacksmith-2vcpu-ubuntu-2404-arm
    timeout-minutes: 45
    steps:
      - uses: Expensify/GitHub-Actions/.github/actions/ai-pr-reviewer@<sha>
        with:
          pr_number: ${{ github.event.pull_request.number }}
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          github_token: ${{ github.token }}
          read_token: ${{ secrets.<token that can read llm-skills-library> }}
```

Don't check out the repository in the job: the action checks out the base branch itself. In a public repository, put a contributor authorization job in front of it, as `App` does for `claude-review.yml`.

## Inputs

| Name | Default | Description |
| --- | --- | --- |
| `pr_number` | | PR to review. |
| `anthropic_api_key` | | Anthropic API key. |
| `github_token` | | Token for the PR repository with `contents: read` and `pull-requests: write`. |
| `read_token` | | Token that can read the private `Expensify/llm-skills-library`, and the private repositories of issues the PR links to. |
| `skills_ref` | pinned commit | `llm-skills-library` commit to load the skill from. Bump it to ship skill changes. |
| `model` | `claude-opus-5-5` | Claude model. |
| `effort` | `high` | Claude reasoning effort. |

## How a run works

1. `prepareReviewContext.sh` reads the PR, its diff, comments and linked issues into a context directory, so the model needs no GitHub access. A public PR never gets the contents of a private issue, because the review is public.
2. It reads the commit the previous review covered from a marker in the PR description, and picks a mode:
   - `first`: no earlier review, so review the whole diff.
   - `incremental`: new commits on top of the reviewed one. The model gets its earlier review and the patches since then, re-checks each earlier finding, marks fixed ones resolved and never raises a finding twice. Patches are limited to files the PR changes, so merging `main` in does not pull other people's changes into the review.
   - `rewritten`: the branch was force-pushed, so review the whole diff again, still re-checking the earlier findings.
   - If the earlier review already covers the head commit (for example on `ready_for_review` after a review of the same commit), the run stops.
3. The base branch is checked out as the workspace, and `extractHeadFiles.sh` copies the PR's changed files at its head commit into `.ai-review/head/`. The PR head is never checked out, so nothing in it can configure or run tools (the `pull_request_target` "pwn request" risk), and the model may only read files. The skill is installed in `~/.claude/skills` because `claude-code-action` resets the workspace `.claude/` to the base branch's.
4. The skill verifies each blocking finding with a separate subagent before reporting it, tags bugs the PR did not introduce as **Pre-existing**, and drops style-only findings.
5. `postReviewToPrBody.sh` re-reads the description and replaces only the text between `<!-- expensify-ai-reviewer:start -->` and `<!-- expensify-ai-reviewer:end -->`, so people's edits stay. It refuses to post a review that contains one of the action's secrets, and shortens a review that would push the description past GitHub's 65536-character limit. When the description has almost no room left, the block keeps only its summary line, and when even that does not fit, the description is left as people wrote it. The full review is always in the run summary.

## Tests

`tests/aiPrReviewer.test.ts` runs both scripts against a fake `gh`. Run `npm test` from the repository root.
