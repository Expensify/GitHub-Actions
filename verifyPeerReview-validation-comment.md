## `verifyPeerReview.yml` bypass testing — defenses hold ✅

I ran a red-team validation of the `pull_request_target` security model introduced in [Add verifyPeerReview.yml feature workflow](https://github.com/Expensify/GitHub-Actions/pull/80). The goal was to bypass the `verifyPeerReview` check by opening PRs that modify the workflow / verify script / install hooks with malicious payloads. **All three defenses held**, from both a same-repo branch and an external fork.

### Method

I opened two benign "attack" PRs against `Expensify/GitHub-Actions:main`. Each PR injected a unique marker string (`fc83b33e`) plus a forced `exit 1` into three places at once:

- `.github/workflows/verifyPeerReview.yml` — a new first step: `echo "INJECTED-WORKFLOW-…"; exit 1`
- `scripts/verifyPeerReview.ts` — prepended `console.log('INJECTED-SCRIPT-…'); process.exit(1)`
- `package.json` — a `"postinstall": "echo INJECTED-POSTINSTALL-… && exit 1"`

If any defense failed, the check would either fail (`exit 1`) or leak the marker into the run logs. No real secret was exfiltrated.

**Scope:** this only exercised the workflow as it runs in the `GitHub-Actions` repo itself, where `on: pull_request_target` fires directly because the workflow file lives on `main`. It does **not** cover the org-level ruleset path (the ruleset injecting this check into PRs in other repos such as `App`/`Web-Expensify`), which relies on the same `pull_request_target` model but was not tested here.

| PR | Source | PR head commit | Run |
| --- | --- | --- | --- |
| [#85](https://github.com/Expensify/GitHub-Actions/pull/85) | Same-repo branch (`Expensify/GitHub-Actions`) | `9db4230` | [29298468371](https://github.com/Expensify/GitHub-Actions/actions/runs/29298468371) |
| [#86](https://github.com/Expensify/GitHub-Actions/pull/86) | External fork (`roryabraham/GitHub-Actions`) | `6f07e08` | [29298482993](https://github.com/Expensify/GitHub-Actions/actions/runs/29298482993) |

### Results

Both checks reported **`success`**, and the injected code never ran:

1. **Workflow immutability (`pull_request_target` runs base `main`).** Both runs executed exactly the `main` workflow steps (`Generate a GitHub App token` → `Checkout GitHub-Actions` → `Setup Node` → `Install npm packages` → `Verify peer review`). The injected `Injected attack step (PR head workflow)` **does not appear** in either run, and neither `exit 1` took effect.

2. **Script + install-hook immutability (only `GitHub-Actions@main` is checked out).** The `Checkout GitHub-Actions` step resolved to `e1bbd20` — the current `main` tip — **not** the PR head commits (`9db4230` / `6f07e08`). `npm ci` reported `added 371 packages` with **no** `INJECTED-POSTINSTALL` output, and the verify step printed the real `main` skeleton line:
   > `Verify peer review skeleton invoked for Expensify/GitHub-Actions#85 (base: main). Always passes for now.`

3. **No untrusted checkout / no secret leak.** A full-log grep for the marker `fc83b33e` returned **0 matches** in both runs. None of `INJECTED-WORKFLOW`, `INJECTED-SCRIPT`, or `INJECTED-POSTINSTALL` appeared. The PR head repo was never checked out.

Notably, on the **fork PR (#86)** the `Generate a GitHub App token` step still **succeeded** — confirming that `pull_request_target` does expose `PEER_REVIEW_CHECKER_PRIVATE_KEY` to the base workflow even for fork PRs — yet because no PR-head code is ever executed, the secret is never reachable by attacker-controlled code. This is exactly the risk the design neutralizes.

### Cleanup

Both test PRs were closed and their branches deleted.
