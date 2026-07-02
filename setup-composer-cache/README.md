# setup-composer-cache

Composite action that restores Composer download caches and optionally installs dependencies.

## Inputs

| Input               | Required | Default | Description                                                                 |
| ------------------- | -------- | ------- | --------------------------------------------------------------------------- |
| `working_directory` | No       | `.`     | Directory containing `composer.json` and `composer.lock`.                   |
| `dev`               | No       | `false` | When `run_install` is true, pass `--dev` instead of `--no-dev` to Composer. |
| `run_install`       | No       | `false` | Run `composer install` after restoring caches.                              |

## Usage

### Cache only (Auth)

```yml
- name: Setup Composer Cache
  uses: Expensify/GitHub-Actions/setup-composer-cache@main
  with:
    working_directory: Web-Expensify
```

### Cache and install (Web-Expensify / Web-Secure / PHP-Libs)

```yml
- name: Setup Composer Cache
  uses: Expensify/GitHub-Actions/setup-composer-cache@main
  with:
    run_install: true
    dev: true
```

## Cache keys

| Cache             | Paths                        | When                |
| ----------------- | ---------------------------- | ------------------- |
| Composer download | Composer `cache-files-dir`   | Always              |
| Vendor            | `{working_directory}/vendor` | `run_install: true` |

Composer download caches are keyed by runner OS, dev/prod variant, and `composer.lock` hash, with restore keys that fall back to the most recent cache for that OS and variant. Vendor caches use an exact key only (no restore keys) so a tree built from a different lock file is never reused.
