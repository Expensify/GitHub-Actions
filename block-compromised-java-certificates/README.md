# Block compromised Java certificates

Patch the selected JVM's certificate blocklist **after Java setup/cache restoration and before Maven, Gradle, SDK tools, or other Java network operations** to protect against the [eMudhra intermediate CA compromise](https://ops.java/emudhra).

```yaml
- uses: actions/setup-java@<reviewed-commit-sha>
  with:
    distribution: temurin
    java-version: '25'

# If using gradle/actions/setup-gradle, run it here so its cache restoration finishes first.
- uses: Expensify/GitHub-Actions/block-compromised-java-certificates@main
  with:
    restrict-gradle: 'true'

- run: ./gradlew build
```

## Behavior

- Defaults to `JAVA_HOME` from `actions/setup-java`.
- Inspects the selected executable's actual `java.home`, vendor, and runtime version. Discovers `lib/security/blocked.certs` or `lib/security/blacklisted.certs` there, including the Java 8 nested JRE layout and distro symlinks.
- Appends only missing fingerprints from the [checked-in certificates](./compromised-java-certificates.pem).
- Merges into existing files, preserving existing blocklist entries. Verifies the resulting file and is idempotent.
- Uses `sudo tee -a` only if a normal append is denied. Interactive runs explain why elevated permission is needed before sudo can prompt; CI and headless runs never prompt. Java discovery and final verification are never elevated.
- Fails the job loudly if patching the blocklist fails.

## Gradle builds

Set `restrict-gradle: 'true'` to configure Gradle **after the selected JVM is successfully protected**. It defaults to `'false'` and is intended for CI builds that use one JDK. The action writes an overriding block to `$GRADLE_USER_HOME/gradle.properties`, or `$HOME/.gradle/gradle.properties` when `GRADLE_USER_HOME` is unset:

- Selects the protected JDK with `org.gradle.java.home`.
- Disables toolchain auto-detection and auto-download.
- Clears additional environment-provided toolchain locations and restricts installation paths to the protected JDK.
- Preserves unrelated file contents and permissions; repeating the same configuration is a no-op.

`JAVA_HOME` must select the protected JDK, including when the `java-home` input is supplied. This keeps the Gradle launcher on the same JVM; the action does not switch `JAVA_HOME` or `PATH`. Run it after Java setup and **all Gradle cache restoration**, before any Gradle command. Reapply if a later step replaces the JDK, changes the Gradle user home, or overwrites these properties. Restart existing Gradle daemons before resuming builds.

The selected JDK must satisfy the build's Java/toolchain requirements and any `gradle/gradle-daemon-jvm.properties` criteria. A build requiring another JDK will fail rather than select/download an unprotected installation. Multi-JDK builds should explicitly provision and protect their required runtimes and configure their own toolchain policy. Explicit command-line/property overrides, a different `--gradle-user-home`, and custom Java launches can bypass this configuration; it is not a sandbox for arbitrary build code.

See Gradle's [toolchain configuration](https://docs.gradle.org/current/userguide/toolchains.html#sec:auto_detection) and [daemon JVM criteria](https://docs.gradle.org/current/userguide/gradle_daemon.html#sec:daemon_jvm_criteria).

## Developer laptops

Requires Python 3.9+ on Linux/macOS, with no packages to install. From an Expensidev checkout:

```bash
python3 GitHub-Actions/scripts/blockCompromisedJavaCertificates.py --all --dry-run
python3 GitHub-Actions/scripts/blockCompromisedJavaCertificates.py --all --apply
```

Discovery checks `JAVA_HOME`, `JDK_HOME`, all Java entries on `PATH`, the macOS Java registry, standard JDK directories, Homebrew, SDKMAN/asdf/mise/jenv, Gradle JDKs, Android Studio/JetBrains runtimes, and CI tool caches. Runtime aliases and resolved blocklist paths are deduplicated before any files are updated.

Searches are bounded (normally six directory levels); they do not scan the entire filesystem. Add custom or deeper locations with `--all --search-root /path/to/jdks`. Arbitrary locations, archives, inaccessible directories, other users' homes, containers, and VMs require separate coverage. `--json` includes searched roots, skipped locations, a `runtimes` inventory, and per-file results in `blocklists`. Any search/access/patch failure produces a nonzero exit, while other discovered files are still processed.

Dry-run is the default and never modifies blocklists or requests sudo. Run as your normal user. If an append requires sudo, interactive runs explain why and allow sudo to request your password. CI and headless runs use noninteractive sudo and fail if authorization is unavailable. To target one installation, use `--java-home /path/to/jdk` instead of `--all` (or set `JAVA_HOME`).

Restart existing JVMs, IDEs, and Gradle daemons after patching. Rerun after JDK installations or updates, including newly downloaded Gradle toolchains. The blocklist protects standard JVM certificate validation, not custom TLS implementations that bypass it.
