# setup-ubuntu-gpg-cache

Composite action that installs the Expensify aptly GPG key and caches Ubuntu apt keyserver exports so CI jobs can run `apt-get` without repeated keyserver lookups.

## Usage

```yaml
- name: Setup Ubuntu GPG Cache
  uses: Expensify/GitHub-Actions/setup-ubuntu-gpg-cache@main
```

## What it does

1. Installs `aptly-public.gpg` from the action directory into `/etc/apt/trusted.gpg.d/aptly.gpg`.
2. Restores a daily GPG key export from the GitHub Actions cache.
3. On an exact same-day cache hit, imports the cached keys.
4. On a miss or stale partial hit, fetches required keys from `keyserver.ubuntu.com` and re-exports them for caching.
