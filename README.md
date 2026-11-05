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

Org-level ruleset workflow that verifies pull requests have an independent employee approval — e.g. blocking cases where an employee self-approves a pull request they asked Melvin to create.

Configure it to run via an org [ruleset](#rulesets) that requires this workflow on `pull_request_target` events. See the Rulesets section below for caveats.

The check only reads GitHub pull request metadata via the API; it does not checkout or execute code from the pull request branch. It uses `pull_request_target` so the workflow YAML and scripts always run from `main`, and only `GitHub-Actions@main` is checked out.

This workflow requires a GitHub App token with read access for repository metadata, pull requests, organization members, and branch administration. It uses the Peer Review Checker app ID `3877737` and the org secret `PEER_REVIEW_CHECKER_PRIVATE_KEY` to generate that token.

- If the target branch has no branch-protection rule, or has one that requires zero approving reviews, the check passes.
- If branch protection cannot be read — missing permissions, an API error, an unknown branch, or a response the script can't interpret — the check fails rather than assuming a review count.
- Co-authors of bot-authored commits count as authors. Each `Co-authored-by` email is resolved to a login from the `users.noreply.github.com` pattern, or otherwise by asking GitHub which user has verified that email. The check fails if an email can't be resolved either way.

### `secretScan.yml`

Scans a repository for committed credentials using [TruffleHog](https://github.com/trufflesecurity/trufflehog).

Add one caller per repository:

```yml
# .github/workflows/secret-scan.yml
on:
  push:

jobs:
  secretScan:
    uses: Expensify/GitHub-Actions/.github/workflows/secretScan.yml@main
    with:
      # Optional. Fail the job on a finding. Leave unset to warn only.
      should_fail_on_findings: false

      # Optional. File of newline-separated regexes for paths to skip.
      # Ignored when the file does not exist.
      exclude_paths_file: .github/trufflehog-exclude-paths.txt

      # Optional. Runner label.
      runner: blacksmith-2vcpu-ubuntu-2404
```

Scan on `push`, not on `pull_request`. Every commit in a pull request is pushed first, so `push` covers the same ground and also covers a branch that never opens a pull request — which is how credentials go unnoticed for years. Add a second caller on `pull_request` only where external forks contribute, such as `App`, because a fork's own push never reaches us.

The scan scope follows the triggering event:

| Event | Scope |
| --- | --- |
| `push` | The commits the push introduced |
| `pull_request` | The commits in the pull request |
| `schedule`, `workflow_dispatch` | The full history |

Any other event fails the job with an explicit error rather than scanning the wrong range. The scan reads `file:///repo` and cannot reach the remote, so an event only qualifies if the local clone is guaranteed to hold the commits it names. `pull_request_target` does not qualify, because it checks out the base repository and an external fork's head commit is absent.

Add `workflow_dispatch` to the caller too. `push` only covers commits that land after the workflow exists, so run it once from the Actions tab to scan the history that predates it. Do not add a `schedule`: history does not change, so repeating a full scan reports the same answer every time.

Three pushes need care, and the workflow handles each:

- **Deleting a ref** introduces no commits, so it is skipped.
- **A tag push** is skipped only if the tagged commit already reaches a branch. Git allows pushing a tag whose commit reaches no branch, which transfers that commit with the tag, and that is the only event that can scan it.

### Known gap: more than three tags at once

GitHub [does not create events](https://docs.github.com/en/webhooks/webhook-events-and-payloads) for tags when more than three are pushed at once, so `git push --tags` with four or more tags starts no workflow run. A commit reaching no branch, carried in such a batch, therefore goes unscanned.

Run the workflow from the Actions tab to recover. A `schedule` would close this automatically, but today a full scan re-reports every finding already in history, so the noise costs more than the gap. Once findings create deduplicated issues, repeats collapse and a schedule becomes worth adding.
- **A force push or a new branch** names no usable starting commit, so the scan falls back to the point where the branch left the default branch. Where there is no shared ancestor at all — an orphan branch, a new repository, a force push to the default branch — it scans the whole branch, because no later push covers those commits.

Eight behaviours worth knowing before you change anything:

- The scan runs with `--no-verification`. Verification authenticates each candidate against its live provider, and a burst of failed authentication attempts from CI is indistinguishable from credential stuffing in CloudTrail. A consequence is that every finding is classified `unverified`, so do not add `--results=verified` — it would report nothing.
- Warn-only mode suppresses findings, not errors. TruffleHog exits 183 for a finding and 1 for an operational error such as a failed image pull, and the workflow branches on that exit code. With `should_fail_on_findings: false` a 183 becomes a warning annotation, while every other non-zero exit still fails the job. A scan that never ran must not report a pass, so do not reach for `continue-on-error` here — it cannot tell those two exits apart.
- The workflow runs the TruffleHog container directly rather than using `trufflesecurity/trufflehog`. That action hardcodes `--fail` and exposes no exit code, and `--fail` cannot be repeated, so `--no-fail` is rejected with `flag 'fail' cannot be repeated`. Reading the exit code is the only way to separate the two failure kinds above. The image is pinned by digest.
- The workflow checks that every commit in the scan range resolves locally before it starts. TruffleHog aborts with an unhelpful operational error on a missing commit, so this turns that into a message naming the commit.
- The checkout needs `fetch-depth: 0`, despite costing around 1 GB on `Auth` or `Web-Expensify`. TruffleHog resolves the merge base for `--since-commit` through go-git, which ignores `.git/shallow` and fails with `unable to resolve merge base: object not found` on a shallow clone at any depth. Real `git merge-base` handles the same clone fine, so this is a go-git limitation rather than something depth tuning can fix.
- `--fail-on-scan-errors` is not optional. Without it TruffleHog logs a scan error, reads zero commits and still exits 0, so a scan that covered nothing reports a clean result. That is the same silently-green-check failure the exit-code branching exists to prevent.
- TruffleHog needs an access key ID adjacent to a plausible secret to detect an AWS credential, so it misses keys split across separate `key = value` lines. Treat a clean scan as a weak signal, not proof.

- A finding does not fail the check, by design. A credential that has been pushed is already compromised, so blocking a merge does not undo the leak. The value is detection latency, and rotation is the response.

This repository scans itself via `secretScanSelf.yml`, which uses a local ref so that a pull request changing `secretScan.yml` is checked by the version it proposes.

### `setup-composer-cache`

Restores Composer download caches and optionally runs `composer install`. See [setup-composer-cache/README.md](./setup-composer-cache/README.md) for details.

```yml
- name: Setup Composer Cache
  uses: Expensify/GitHub-Actions/setup-composer-cache@main
  with:
    run_install: true
    dev: false
```

### `block-compromised-java-certificates`

Protect the JVM selected by `actions/setup-java` before Java network operations, including on JDK cache hits. The same dependency-free Python script can discover and patch Java installations on developer laptops. See [usage](./block-compromised-java-certificates/README.md).

```yaml
- uses: Expensify/GitHub-Actions/block-compromised-java-certificates@main
```

### `bumpNode.yml`

Rolls Node.js releases out to the repos listed in [`config/nodeBump.json`](./config/nodeBump.json). It runs in this repository, so the repos don't need a caller workflow.

Each repo's `.nvmrc` decides how it pins Node.js:

- **Floats on a major line** (`.nvmrc` holds `26`). CI installs the newest 26.x release on every run, because `setup-node` sets `check-latest: true`, and `engines`, `devEngines` and `checkRuntimeVersions.sh` only set a minimum. Patch releases need no pull request. The workflow raises the minimums only when asked to.
- **Pins an exact release** (`.nvmrc` holds `26.12.1`). Every release needs a pull request, which the workflow opens.

The workflow never makes a major upgrade, since those need code changes.

**Every hour** it checks https://nodejs.org/dist/index.json for a security release from the last 14 days on a major line the repos use. When a release has no tracking issue yet, it opens one in `Expensify/Expensify` with the rollout steps.

**Run it from the Actions tab** with the tracking issue's URL. A dry run prints each repo's diff to the log. A real run opens a pull request in every repo that needs one, then comments the results on the issue.

| Input | Effect |
| --- | --- |
| `ISSUE_URL` | Tracking issue that the pull requests and the results comment link to |
| `VERSION` | Exact release to move to. Only repos on its major line change. Leave empty to move each repo to the newest release on its line |
| `REPOS` | Comma-separated subset of the config. Leave empty for every repo |
| `RAISE_MINIMUMS` | Also raise the minimums of repos that float, so developer machines and the build boxes have to move to the release |
| `DRY_RUN` | Checked by default |

Each repo in the config can set:

- `holdForBuildBoxes`: Jenkins builds the repo on the build boxes and checks the Node.js version first, so its pull request starts with `[HOLD]` until the build boxes run the release.
- `securityReleaseTitlePrefix`: added to the pull request title when the bump includes a security fix, for example `[CP Staging & Prod]`.

Behaviours worth knowing:

- The commit is created through the GraphQL API as `os-botify[bot]`, so GitHub signs it, and it credits whoever ran the workflow as a co-author. `verifyPeerReview.yml` then needs one independent approval instead of the two it requires for bot-only pull requests, and that person can't approve their own bump.
- Each repo is cloned sparsely, with only the files that pin versions, so even App takes a few seconds.
- npm only changes where it is pinned to exactly the npm bundled with the old release. Minimums such as `>=11.10.0` stay put.
- A JSON file is only rewritten when nothing but the version lines changes. Otherwise that repo fails and asks for a hand edit.
- The GitHub App token only reaches the repos in the config, and can only write to their contents and pull requests on manual runs. The OSBotify app has to be installed on every repo in the config, or creating the token fails.

To bump a local checkout the same way:

```bash
npm run bump-node -- --repo-dir ../App [--version 26.13.1] [--raise-minimums]
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
