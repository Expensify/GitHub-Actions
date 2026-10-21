# Public certificate fixtures

`impacted-certificates.pem` contains the 16 public certificates from the `pem` fields of <https://emudhra.we-have-a-problem.com/impacted-intermediates.json>. There are no private keys here. Keeping these fixtures in the repository makes verification independent of that incident site's availability.

`VerifyBlockedCertificates.java` checks that their SHA-256 certificate fingerprints match the committed action manifest exactly, that the selected JVM's `sun.security.util.UntrustedCertificates.isUntrusted` rejects every certificate, and that an unaffected trust-anchor control is not blocked. It uses reflection so it compiles with Java 8+ without compiling against internal APIs. Java 9+ execution needs `--add-exports=java.base/sun.security.util=ALL-UNNAMED`.

This is an offline check of the standard JVM blocklist mechanism, not an end-to-end test of every TLS provider or application trust manager.
