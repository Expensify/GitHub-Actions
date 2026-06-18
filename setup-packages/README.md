# setup-packages

Composite action that installs the Expensify aptly GPG key, configures internal apt-mirror sources, and runs `apt-get update`.

## Usage

```yaml
- name: Provision and use our internal apt-mirror
  uses: Expensify/GitHub-Actions/setup-packages@main
  with:
    APT_PASSWORD: ${{ secrets.TRAVIS_APT_PASSWORD }}
```

## Inputs

| Input          | Required | Description                                                         |
| -------------- | -------- | ------------------------------------------------------------------- |
| `APT_PASSWORD` | Yes      | Password for the internal apt-mirror (`TRAVIS_APT_PASSWORD` secret) |

## What it does

1. Installs `aptly-public.gpg` from the action directory into `/etc/apt/trusted.gpg.d/aptly.gpg`.
2. Adds Expensify apt-mirror sources for `ubuntu-toolchain-noble` and `php-ppa-noble`.
3. Runs `apt-get update` to refresh package indexes.
