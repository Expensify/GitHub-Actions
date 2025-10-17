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
      repository: ''

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

## Rulesets
GitHub [org-level Rulesets](https://docs.github.com/en/enterprise-cloud@latest/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-workflows-to-pass-before-merging) can be configured to run a workflow check against pull requests in all repos in the org. This is a very powerful feature, but there are some caveats and best practices to be aware of when enabling a Ruleset.

- Supported Event Triggers are documented [here](https://docs.github.com/en/enterprise-cloud@latest/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#supported-event-triggers). However, when a workflow runs in response to a Ruleset, some configs such as `branches`, `paths`, `paths-ignore`, that would normally be valid in a workflow are ignored. If you need to target or exclude specific branches, that can be configured in the Ruleset settings. If you need to target or exclude specific paths, that must be implemented manually in the workflow itself.
- Due to a GitHub :bug:, PRs that are open when the rule is enabled will get stuck with a pending check that will never get picked up. The easiest way to fix that is to close and reopen the PR. Consider writing a script to close and reopen all open PRs across the org after the check is enabled.
- It is less disruptive to [configure the Ruleset to `Evaluate` first](https://docs.github.com/en/enterprise-cloud@latest/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#using-evaluate-mode-for-ruleset-workflows), then `Active` once the kinks are worked out.
