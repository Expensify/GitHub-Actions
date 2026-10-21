# Block compromised Java certificates

Patch the selected JVM's certificate blocklist **after Java setup/cache restoration and before Maven, Gradle, SDK tools, or other Java network operations**. Selecting a newer JDK alone does not guarantee protection against the [eMudhra intermediate CA compromise](https://ops.java/emudhra).

```yaml
- uses: actions/setup-java@<reviewed-commit-sha>
  with:
    distribution: temurin
    java-version: '25'

- uses: Expensify/GitHub-Actions/block-compromised-java-certificates@<reviewed-commit-sha>

- run: ./gradlew build
```

## Behavior

- Defaults to `JAVA_HOME` from `actions/setup-java`. Optional `java-home` selects another JDK/JRE; ensure the subsequent workload actually uses that installation.
- Inspects the selected executable's actual `java.home`, vendor, and runtime version. Discovers `lib/security/blocked.certs` or `lib/security/blacklisted.certs` there, including the Java 8 nested JRE layout and distro symlinks.
- Appends only missing fingerprints from the [checked-in 16-certificate list](./compromised-java-certificates.txt), including AAA cross-signs and code-signing CAs. No security policy is downloaded at runtime. Pin the action by commit SHA, and update that pin when the reviewed policy changes.
- Preserves the existing file, entries, `Algorithm=SHA-256`, symlinks, ownership, and permissions. Verifies the resulting file and is idempotent.
- Uses noninteractive `sudo` on Linux/macOS only if file access requires it. Java discovery is never elevated. Windows requires permission to update the file and never changes ACLs to gain access.
- Fails the job on missing/ambiguous blocklists, unsupported formats, non-SHA-256 algorithms, or failed verification. It does not create an unused blocklist and silently report success.

This is a composite action running TypeScript directly with pinned Bun. It does not require a caller checkout, install npm dependencies, bundle JavaScript, or change the caller's Node version. It installs/selects Bun for the job. Source code uses Bun Shell for safely quoted subprocess execution and the repository's existing TypeScript quality checks.

## Compatibility and limits

Targets Java 8+ installations using OpenJDK-style certificate blocklists on Linux, macOS, and Windows, independent of the distribution selected in `actions/setup-java`. The integration workflow exercises representative Temurin, Zulu, Corretto, Microsoft, Oracle, and Semeru runtimes; see [the test matrix](../.github/workflows/javaCertificateBlocklist.yml) for exact combinations. Unknown layouts fail closed; this is not a claim of support for every historical Java release or vendor-specific validation provider.

File verification confirms policy coverage, not every application's TLS behavior. Custom security providers or trust managers that bypass the JVM blocklist need separate assessment. It does not patch Android devices, native TLS stacks, other installed JDKs, or automatically downloaded Gradle toolchains. Run it for every JVM the job will use and prevent unprotected toolchain selection.

Run unconditionally, including on JDK cache hits. Run again after any later cache restore or installation that could overwrite the blocklist. Existing JVMs/Gradle daemons must be restarted: the blocklist is loaded into memory. This action does not stop running processes or edit truststores.

The committed manifest is a reviewed incident snapshot, not an arbitrary caller-supplied denylist. Changes to its membership must update its validation and tests together.
