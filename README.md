# Expensify Shared GitHub Actions workflows 🔄

## What is the repository used for?

Expensify has multiple repositories that use the same GitHub Actions workflows. This repository centralizes and consolidates frequently used workflows to enhance security and maintain consistent standards across projects.

## Usage

### `npmPublish.yml`

Used to publish a package to [npmjs](https://www.npmjs.com/), should be triggered when code is merged into the `main` branch. **Note**: Please follow [these instructions](https://stackoverflowteams.com/c/expensify/questions/17043/17044#17044) to grant our bots the correct access to publish.

```yml
jobs:
  publish:
    uses: Expensify/GitHub-Actions/.github/workflows/npmPublish.yml@main
    secrets: inherit
    with:
      # Repository name with owner. For example, Expensify/eslint-config-expensify
      # Required, String, default: ${{ github.repository }}
      repository: ""

      # True if we should run npm run build for the package
      # Optional, Boolean, default: false
      should_run_build: true
```

### `cla.yml`

Used to check if a user has signed the [Contributor License Agreement](./CLA.md), Should be triggered when a PR is opened or updated.

```yml
jobs:
  CLA:
    uses: Expensify/GitHub-Actions/.github/workflows/cla.yml@main
    # Required to pass along secrets for `CLA_BOTIFY_TOKEN`
    secrets: inherit
```

### `verifyPeerReview.yml`

Intended to run as an org-level ruleset workflow to block pull requests that don't have an independent approval — i.e. an approval from an Expensify employee other than the PR's author(s)/co-author(s) — across every repo in the org. See the "Rulesets" section below for the general caveats of running a workflow this way.

**Current status: no-op skeleton.** The workflow itself is fully wired up (GitHub App token generation, checkout, `npm ci`, invoking `npm run verify-peer-review`), but the underlying `scripts/verifyPeerReview.ts` script it calls is still the Phase 1 no-op skeleton — it parses its CLI arguments and always exits `0` without checking anything. This lets the workflow's plumbing (App permissions, secrets, cross-repo checkout) be validated end-to-end, including via a ruleset's [`Evaluate` mode](https://docs.github.com/en/enterprise-cloud@latest/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#using-evaluate-mode-for-ruleset-workflows), before the real peer-review logic ships in a follow-up. Until then, this check will always pass.

The workflow triggers on `pull_request` and `pull_request_review` (`submitted`, `dismissed`), so it re-evaluates when reviews change without requiring a new push.

It requires a GitHub App token (client ID `3877737`) generated from the `PEER_REVIEW_CHECKER_PRIVATE_KEY` org secret, requesting `administration:read`, `contents:read`, `members:read`, `metadata:read`, and `pull-requests:read` permissions on both the triggering repo and this `GitHub-Actions` repo.

```yml
name: Verify peer review
run-name: Verify peer review for ${{ github.repository }}#${{ github.event.pull_request.number }}

on:
  pull_request:
  pull_request_review:
    types: [submitted, dismissed]

permissions:
  contents: read
  pull-requests: read

jobs:
  verifyPeerReview:
    name: Check independent approval
    runs-on: blacksmith-2vcpu-ubuntu-2404
    steps:
      - name: Generate a GitHub App token
        id: generateAppToken
        uses: actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1
        with:
          client-id: "3877737"
          private-key: ${{ secrets.PEER_REVIEW_CHECKER_PRIVATE_KEY }}
          owner: ${{ github.repository_owner }}
          repositories: |
            ${{ github.event.repository.name }}
            GitHub-Actions
          permission-administration: read
          permission-contents: read
          permission-members: read
          permission-metadata: read
          permission-pull-requests: read

      - name: Checkout repos
        id: repo
        uses: Expensify/GitHub-Actions/checkoutRepoAndGitHubActions@main

      - name: Setup Node
        uses: actions/setup-node@395ad3262231945c25e8478fd5baf05154b1d79f
        with:
          node-version-file: GitHub-Actions/.nvmrc
          cache: npm
          cache-dependency-path: GitHub-Actions/package-lock.json

      - name: Install npm packages
        run: npm ci
        working-directory: GitHub-Actions

      - name: Verify peer review
        run: >-
          npm run verify-peer-review --
          --owner ${{ github.repository_owner }}
          --repo ${{ github.event.repository.name }}
          --pull-request-number ${{ github.event.pull_request.number }}
          --base-ref ${{ github.event.pull_request.base.ref }}
        working-directory: GitHub-Actions
        env:
          GITHUB_TOKEN: ${{ steps.generateAppToken.outputs.token }}
```

### `setup-composer-cache`

Restores Composer download caches and optionally runs `composer install`. See [setup-composer-cache/README.md](./setup-composer-cache/README.md) for details.

```yml
- name: Setup Composer Cache
  uses: Expensify/GitHub-Actions/setup-composer-cache@main
  with:
    run_install: true
    dev: false
```

## Rulesets

GitHub [org-level rulesets](https://docs.github.com/en/enterprise-cloud@latest/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-workflows-to-pass-before-merging) can be configured to run a workflow check against pull requests in all repos in the org. This is a very powerful feature, but there are some caveats and best practices to be aware of when enabling a ruleset.

- Supported Event Triggers are documented [here](https://docs.github.com/en/enterprise-cloud@latest/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#supported-event-triggers). However:
  - When a workflow runs in response to a ruleset, some configs such as `branches`, `paths`, `paths-ignore`, that would normally be valid in a workflow are ignored.
  - The default activity types for each event will be used. This means that something like `pull_request:comment` will not work - the `pull_request` event will always be triggered for the default activity types listed in the documentation.
  - If you need to target or exclude specific branches, that can be configured in the ruleset settings.
  - If you need to target or exclude specific paths, that must be implemented manually in the workflow itself.
- Due to a GitHub :bug:, PRs that are open when the rule is enabled will get stuck with a pending check that will never get picked up. The easiest way to fix that is to close and reopen the PR. Consider writing a script to close and reopen all open PRs across the org after the check is enabled.
- It is less disruptive to [configure the ruleset to `Evaluate` first](https://docs.github.com/en/enterprise-cloud@latest/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#using-evaluate-mode-for-ruleset-workflows), then `Active` once the kinks are worked out.
- For `verifyPeerReview.yml`, start with a ruleset targeting only a test branch, then test the workflow from a GitHub-Actions branch, then from `main`, and only then enable it for the intended repositories and branches.
