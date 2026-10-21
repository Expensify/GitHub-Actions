import java.io.InputStream;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.cert.Certificate;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.util.Collection;
import java.util.Enumeration;
import java.util.HashSet;
import java.util.Set;

/** Offline integration check of the selected JVM's actual denylist, not just its file contents. */
public class VerifyBlockedCertificates {
    public static void main(String[] args) throws Exception {
        Set<String> expected = new HashSet<>();
        for (String line : Files.readAllLines(Paths.get(args[0]), StandardCharsets.US_ASCII)) {
            if (!line.trim().isEmpty() && !line.startsWith("#")) {
                expected.add(line.trim());
            }
        }
        Collection<? extends Certificate> certificates;
        try (InputStream input = Files.newInputStream(Paths.get(args[1]))) {
            certificates = CertificateFactory.getInstance("X.509").generateCertificates(input);
        }
        Method isUntrusted = Class.forName("sun.security.util.UntrustedCertificates")
                .getMethod("isUntrusted", X509Certificate.class);
        Set<String> actual = new HashSet<>();
        for (Certificate certificate : certificates) {
            StringBuilder fingerprint = new StringBuilder();
            for (byte value : MessageDigest.getInstance("SHA-256").digest(certificate.getEncoded())) {
                fingerprint.append(String.format("%02X", value & 0xff));
            }
            actual.add(fingerprint.toString());
            if (!Boolean.TRUE.equals(isUntrusted.invoke(null, certificate))) {
                throw new AssertionError("JVM does not block " + fingerprint);
            }
        }
        if (expected.size() != 16 || certificates.size() != 16 || !actual.equals(expected)) {
            throw new AssertionError("Certificate fixtures must match all 16 committed fingerprints exactly");
        }

        // A normal trust anchor must still be accepted by the denylist check.
        KeyStore roots = KeyStore.getInstance(KeyStore.getDefaultType());
        try (InputStream input = Files.newInputStream(Paths.get(System.getProperty("java.home"), "lib", "security", "cacerts"))) {
            roots.load(input, "changeit".toCharArray());
        }
        boolean foundControl = false;
        Enumeration<String> aliases = roots.aliases();
        while (aliases.hasMoreElements() && !foundControl) {
            foundControl = Boolean.FALSE.equals(isUntrusted.invoke(null, roots.getCertificate(aliases.nextElement())));
        }
        if (!foundControl) {
            throw new AssertionError("No unaffected trust anchor passed the control check");
        }
        System.out.println("Actual JVM blocks all 16 compromised certificates; unaffected-root control passed.");
    }
}
