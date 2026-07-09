# setup-php-cache

Composite action that restores keyed GitHub Actions caches used by PHP CI workflows.

Caches bin, `.cache`, apt archives, and GPG dirs (with chmod prep for system paths).

## Inputs

| Input          | Required | Description                                              |
| -------------- | -------- | -------------------------------------------------------- |
| `php-version`  | Yes      | PHP version used by the consumer workflow (e.g. `8.3.31`) |

Pass the same version you use with `shivammathur/setup-php` so version-specific system paths are chmod'd only when they exist.

## Usage

```yml
- name: Setup Cache
  uses: Expensify/GitHub-Actions/setup-php-cache@main
  with:
    php-version: 8.3.31
```

## Cache keys

Caches are keyed by runner OS, architecture, and UTC date (`YYYYmmdd`), with restore keys that fall back to the most recent cache for that OS and architecture.

| Cache    | Paths                                            |
| -------- | ------------------------------------------------ |
| Binary   | `_tools/ci/bin`                                  |
| Project  | `.cache`, `/var/cache/apt/archives`              |
| GPG keys | `/etc/apt/trusted.gpg.d`, `/etc/apt/trusted.gpg` |
