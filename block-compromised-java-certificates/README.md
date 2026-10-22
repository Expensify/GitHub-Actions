# Block compromised Java certificates

Patch the selected JVM's certificate blocklist **after Java setup/cache restoration and before Maven, Gradle, SDK tools, or other Java network operations** to protect against the [eMudhra intermediate CA compromise](https://ops.java/emudhra).

```yaml
- uses: actions/setup-java@<reviewed-commit-sha>
  with:
    distribution: temurin
    java-version: '25'

- uses: Expensify/GitHub-Actions/block-compromised-java-certificates@main

- run: ./gradlew build
```

## Behavior

- Defaults to `JAVA_HOME` from `actions/setup-java`.
- Inspects the selected executable's actual `java.home`, vendor, and runtime version. Discovers `lib/security/blocked.certs` or `lib/security/blacklisted.certs` there, including the Java 8 nested JRE layout and distro symlinks.
- Appends only missing fingerprints from the [checked-in certificates](./compromised-java-certificates.pem).
- Merges into existing files, preserving existing blocklist entries. Verifies the resulting file and is idempotent.
- Uses noninteractive `sudo` on Linux/macOS only if file access requires it. Java discovery is never elevated.
- Fails the job loudly if patching the blocklist fails.

## Developer laptops

Requires Python 3.9+ on Linux/macOS, with no packages to install. From an Expensidev checkout:

```bash
python3 GitHub-Actions/scripts/blockCompromisedJavaCertificates.py --all --dry-run
python3 GitHub-Actions/scripts/blockCompromisedJavaCertificates.py --all --apply
```

Discovery checks `JAVA_HOME`, `JDK_HOME`, all Java entries on `PATH`, the macOS Java registry, standard JDK directories, Homebrew, SDKMAN/asdf/mise/jenv, Gradle JDKs, Android Studio/JetBrains runtimes, and CI tool caches. Runtime aliases and resolved blocklist paths are deduplicated before any files are updated.

Searches are bounded (normally six directory levels); they do not scan the entire filesystem. Add custom or deeper locations with `--all --search-root /path/to/jdks`. Arbitrary locations, archives, inaccessible directories, other users' homes, containers, and VMs require separate coverage. `--json` includes searched roots, skipped locations, a `runtimes` inventory, and per-file results in `blocklists`. Any search/access/patch failure produces a nonzero exit, while other discovered files are still processed.

Dry-run is the default and never modifies blocklists or requests sudo. Run as your normal user; apply mode can prompt for permission to update individual files. Use `--non-interactive` to fail rather than prompt, as the composite action does. To target one installation, use `--java-home /path/to/jdk` instead of `--all` (or set `JAVA_HOME`).

Restart existing JVMs, IDEs, and Gradle daemons after patching. Rerun after JDK installations or updates, including newly downloaded Gradle toolchains. The blocklist protects standard JVM certificate validation, not custom TLS implementations that bypass it.
