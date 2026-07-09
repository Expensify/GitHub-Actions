# setup-php-cache

Composite action that restores keyed GitHub Actions caches used by PHP CI workflows.

Caches bin, `.cache`, apt archives, and GPG dirs (with chmod prep for system paths).

## Usage

```yml
- name: Setup Cache
  uses: Expensify/GitHub-Actions/setup-php-cache@main
```

## Cache keys

Caches are keyed by runner OS and UTC date (`YYYYmmdd`), with restore keys that fall back to the most recent cache for that OS.

| Cache        | Paths                                            |
| ------------ | ------------------------------------------------ |
| Binary       | `_tools/ci/bin`                                  |
| Project      | `.cache`, `/var/cache/apt/archives`              |
| GPG keys     | `/etc/apt/trusted.gpg.d`, `/etc/apt/trusted.gpg` |
