# Expensify Shared GitHub Actions workflows 🔄 

## What is the repository used for?

Expensify has multiple repositories that use the same GitHub Actions workflows. This repository centralizes and consolidates frequently used workflows to enhance security and maintain consistent standards across projects.

## Usage

### `npmPublish.yml`

```yml
jobs:
  publish:
    uses: Expensify/GitHub-Actions/.github/workflows/npmPublish.yml@main
    secrets: inherit
    with:
      # Repository name with owner. For example, Expensify/eslint-config-expensify
      # Required, String, default: ${{ github.repository }}
      repository: 'Expensify/eslint-config-expensify'

      # Pull request number to comment on when the npm package is published
      # Required, Number
      pull_request_number: 123

      # True if we should run npm run build for the package
      # Optional, Boolean, default: false
      should_run_build: true
```
