# setup-php-cache

Composite action that restores keyed GitHub Actions caches used by PHP CI workflows.

## Inputs

| Input     | Required | Default | Description                                                                                                     |
| --------- | -------- | ------- | --------------------------------------------------------------------------------------------------------------- |
| `variant` | No       | `full`  | `full` caches bin, `.cache`, apt archives, and GPG dirs (with chmod prep). `lite` caches bin and `.cache` only. |

## Usage

### Web-Expensify (`full`)

```yml
- name: Setup Cache
  uses: Expensify/GitHub-Actions/setup-php-cache@main
  with:
    variant: full
```

### Web-Secure (`lite`)

```yml
- name: Setup Cache
  uses: Expensify/GitHub-Actions/setup-php-cache@main
  with:
    variant: lite
```

## Cache keys

Caches are keyed by runner OS and UTC date (`YYYYmmdd`), with restore keys that fall back to the most recent cache for that OS.

| Cache        | Paths                                            | Variant        |
| ------------ | ------------------------------------------------ | -------------- |
| Binary       | `_tools/ci/bin`                                  | `full`, `lite` |
| Project      | `.cache`                                         | `full`, `lite` |
| Apt archives | `/var/cache/apt/archives`                        | `full`         |
| GPG keys     | `/etc/apt/trusted.gpg.d`, `/etc/apt/trusted.gpg` | `full`         |
