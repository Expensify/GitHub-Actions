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
