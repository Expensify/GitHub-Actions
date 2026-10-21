import base64
import contextlib
import errno
import io
import json
import os
import plistlib
import shlex
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
import blockCompromisedJavaCertificates as subject


BUNDLE = subject.CERTIFICATES.read_text(encoding="ascii")
FINGERPRINTS = subject.certificateFingerprints(BUNDLE)
VENDOR = b"Algorithm=SHA-256\n# Preserve vendor entries\n" + b"F" * 64 + b"\n"


class FixtureTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="java-blocklist-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()

    def makeJava(self, name="jdk", specification="25", runtimeHome=None):
        home = self.root / name
        runtime = runtimeHome or (home / "jre" if specification == "1.8" else home)
        (home / "bin").mkdir(parents=True)
        (home / "release").write_text('IMPLEMENTOR="Fixture"\n')
        properties = (f"    java.home = {runtime}\n    java.specification.version = {specification}\n"
                      "    java.vendor = Fixture vendor\n    java.runtime.version = Fixture version\n")
        java = home / "bin/java"
        java.write_text("#!/bin/sh\nprintf '%s' " + shlex.quote(properties) + "\n")
        java.chmod(0o755)
        security = runtime / "lib/security"
        security.mkdir(parents=True, exist_ok=True)
        target = security / ("blacklisted.certs" if specification == "1.8" else "blocked.certs")
        if not target.exists():
            target.write_bytes(VENDOR)
        return home, target

    def invoke(self, arguments):
        output, errors = io.StringIO(), io.StringIO()
        with mock.patch.object(subject.os, "geteuid", return_value=1000):
            with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
                status = subject.main(arguments)
        return status, output.getvalue(), errors.getvalue()


class CertificateTests(unittest.TestCase):
    def testCommittedSnapshot(self):
        self.assertEqual(len(FINGERPRINTS), 16)
        self.assertEqual(len(set(FINGERPRINTS)), 16)
        self.assertEqual(FINGERPRINTS[0], "42C4ACCD12C4F59597925E1A08A7A90102608543809308D50EC427E118BA1493")
        for fingerprint in FINGERPRINTS:
            self.assertRegex(fingerprint, r"^[0-9A-F]{64}$")

    def testMalformedMissingDuplicateAndExtraCertificates(self):
        certificates = subject.re.findall(r"-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----",
                                          BUNDLE, flags=subject.re.DOTALL)
        for bundle in ("bad", "\n".join(certificates[1:]), "\n".join([certificates[0]] * 16), BUNDLE + "extra"):
            with self.subTest(bundle=bundle[:40]):
                with self.assertRaises(ValueError):
                    subject.certificateFingerprints(bundle)
        bad = "-----BEGIN CERTIFICATE-----\n" + base64.b64encode(b"bad").decode() + "\n-----END CERTIFICATE-----"
        with self.assertRaises(ValueError):
            subject.certificateFingerprints("\n".join([bad] + certificates[1:]))


class PropertyTests(unittest.TestCase):
    def testJavaPropertySeparators(self):
        for algorithm in ("Algorithm=SHA-256", "Algorithm : SHA-256", "\tAlgorithm\fSHA-256"):
            for separator in ("", "=", ":ignored", " ignored", "\tignored"):
                content = f"{algorithm}\r\n  {FINGERPRINTS[0]}{separator}\r\n".encode()
                self.assertEqual(subject.blockedFingerprints(content), {FINGERPRINTS[0]})

    def testCommentsLowercaseAndPartialKeysDoNotCount(self):
        content = (f"Algorithm=SHA-256\n# {FINGERPRINTS[0]}\n !{FINGERPRINTS[1]}\n"
                   f"{FINGERPRINTS[2].lower()}\n{FINGERPRINTS[3][1:]}\n").encode()
        self.assertEqual(subject.blockedFingerprints(content), set())

    def testUnicodeLineSeparatorsAreNotJavaNewlines(self):
        content = f"Algorithm=SHA-256\n# Not a new line\x85{FINGERPRINTS[0]}\n".encode("latin1")
        self.assertEqual(subject.blockedFingerprints(content), set())

    def testUnsupportedPropertiesFailClosed(self):
        for content in (b"", b"Algorithm=SHA-512\n", b"Algorithm==SHA-256\n", b"Algorithm=SHA-256 \n",
                        b"Algorithm=SHA-256\nAlgorithm=SHA-256\n", b"Algorithm=SHA-256\nAlgorithm SHA-512\n",
                        b"Algorithm=SHA-256\nAlgorithm\n", b"\xef\xbb\xbfAlgorithm=SHA-256\n",
                        b"Algorithm=SHA-256\nAlgorith\\u006d=SHA-512\n",
                        b"Algorithm=SHA-256\nother=continued\\\n"):
            with self.subTest(content=content), self.assertRaises(ValueError):
                subject.blockedFingerprints(content)


class UpdateTests(FixtureTest):
    def setUp(self):
        super().setUp()
        self.target = self.root / "vendor.certs"
        self.target.write_bytes(VENDOR)
        self.target.chmod(0o640)

    def testDryRunNeverWrites(self):
        before = self.target.stat()
        result = subject.updateBlocklist(self.target, FINGERPRINTS)
        self.assertEqual(result, {"status": "would-patch", "missing": 16, "added": 0})
        self.assertEqual(self.target.read_bytes(), VENDOR)
        self.assertEqual(self.target.stat().st_mtime_ns, before.st_mtime_ns)

    def testAppendPreservesVendorBytesMetadataAndSymlink(self):
        before = self.target.stat()
        link = self.root / "vendor link"
        link.symlink_to(self.target)
        result = subject.updateBlocklist(link.resolve(), FINGERPRINTS, apply=True)
        self.assertEqual(result["added"], 16)
        self.assertTrue(self.target.read_bytes().startswith(VENDOR))
        self.assertTrue(set(FINGERPRINTS).issubset(subject.blockedFingerprints(self.target.read_bytes())))
        self.assertTrue(link.is_symlink())
        for field in ("st_mode", "st_uid", "st_gid", "st_ino", "st_dev"):
            self.assertEqual(getattr(before, field), getattr(self.target.stat(), field))

    def testReadOnlyIdempotence(self):
        subject.updateBlocklist(self.target, FINGERPRINTS, apply=True)
        self.target.chmod(0o400)
        before = self.target.stat()
        content = self.target.read_bytes()
        result = subject.updateBlocklist(self.target, FINGERPRINTS, apply=True)
        self.assertEqual(result["status"], "already-protected")
        self.assertEqual(self.target.read_bytes(), content)
        self.assertEqual(self.target.stat().st_mtime_ns, before.st_mtime_ns)

    def testPartialAndKeyValueEntries(self):
        content = VENDOR + f"{FINGERPRINTS[0]}=\n#{FINGERPRINTS[1]}\n{FINGERPRINTS[2].lower()}\n".encode()
        self.target.write_bytes(content)
        self.assertEqual(subject.updateBlocklist(self.target, FINGERPRINTS, True)["added"], 15)

    def testLineEndingsAndLiteralPaths(self):
        target = self.root / "vendor ' $(echo unsafe).certs"
        for ending in (b"", b"\r", b"\r\n"):
            original = b"Algorithm=SHA-256\r\n# Vendor comment" + ending
            target.write_bytes(original)
            self.assertEqual(subject.updateBlocklist(target, FINGERPRINTS, True)["added"], 16)
            self.assertTrue(target.read_bytes().startswith(original))

    def testMalformedAndMissingFilesAreNotChangedOrCreated(self):
        for content in (b"Algorithm=SHA-512\n", b"Algorithm=SHA-256\nother=continued\\\n"):
            self.target.write_bytes(content)
            with self.assertRaises(ValueError):
                subject.updateBlocklist(self.target, FINGERPRINTS, True)
            self.assertEqual(self.target.read_bytes(), content)
        missing = self.root / "missing"
        with self.assertRaises(FileNotFoundError):
            subject.updateBlocklist(missing, FINGERPRINTS, True)
        self.assertFalse(missing.exists())


class RuntimeTests(FixtureTest):
    def testActualRuntimeHomeVersionsAndLayouts(self):
        for version in ("1.8", "11", "17", "21", "25"):
            home, target = self.makeJava("jdk" + version, version)
            runtime = subject.inspectRuntime(home)
            self.assertEqual(subject.resolveBlocklist(runtime["home"]), target)

    def testAmbiguousOrMissingBlocklistFails(self):
        home, target = self.makeJava()
        (target.parent / "blacklisted.certs").write_bytes(VENDOR)
        with self.assertRaises(ValueError):
            subject.resolveBlocklist(home)
        target.unlink()
        (target.parent / "blacklisted.certs").unlink()
        with self.assertRaises(ValueError):
            subject.resolveBlocklist(home)

    def testInspectionFailuresDoNotLeakJvmDiagnostics(self):
        home, target = self.makeJava()
        java = home / "bin/java"
        java.write_text("#!/bin/sh\necho 'JAVA_TOOL_OPTIONS: SECRET_SENTINEL' >&2\nexit 1\n")
        results = subject.run([home], FINGERPRINTS, True, True)
        self.assertEqual(results[0]["status"], "failed")
        self.assertNotIn("SECRET_SENTINEL", json.dumps(results))
        self.assertEqual(target.read_bytes(), VENDOR)

    def testUnsupportedVersionAndProperties(self):
        home, _ = self.makeJava(specification="1.7")
        with self.assertRaisesRegex(ValueError, "Java 8"):
            subject.inspectRuntime(home)
        response = subprocess.CompletedProcess([], 0, b"java.home = relative\n", b"SECRET_SENTINEL")
        with mock.patch.object(subject.subprocess, "run", return_value=response):
            with self.assertRaises(ValueError) as raised:
                subject.inspectRuntime(home)
            self.assertNotIn("SECRET_SENTINEL", str(raised.exception))

    def testRuntimeAndSharedBlocklistDeduplication(self):
        home, target = self.makeJava("first")
        alias, _ = self.makeJava("alias", runtimeHome=home)
        self.assertEqual(len(subject.run([home, alias], FINGERPRINTS, False, True)), 1)
        second, secondTarget = self.makeJava("second")
        secondTarget.unlink()
        os.link(target, secondTarget)
        results = subject.run([home, second], FINGERPRINTS, True, True)
        self.assertEqual([result["status"] for result in results], ["patched", "shared-blocklist"])

    def testPartialFailureStillProcessesOtherJvms(self):
        home, target = self.makeJava()
        results = subject.run([self.root / "absent", home], FINGERPRINTS, True, True)
        self.assertEqual([result["status"] for result in results], ["failed", "patched"])
        self.assertEqual(len(set(FINGERPRINTS) & subject.blockedFingerprints(target.read_bytes())), 16)


class DiscoveryTests(FixtureTest):
    def testKnownSourcesIncludeOverridesAndPlatformLocations(self):
        environment = {"SDKMAN_DIR": "/custom/sdkman", "ASDF_DATA_DIR": "/custom/asdf",
                       "MISE_DATA_DIR": "/custom/mise", "JENV_ROOT": "/custom/jenv",
                       "GRADLE_USER_HOME": "/custom/gradle", "RUNNER_TOOL_CACHE": "/custom/toolcache"}
        roots = {str(root.path) for root in subject.defaultRoots(environment, self.root, "darwin")}
        self.assertTrue({"/custom/sdkman/candidates/java", "/custom/asdf/installs/java",
                         "/custom/mise/installs/java", "/custom/jenv/versions", "/custom/gradle/jdks",
                         "/custom/toolcache", "/Applications", "/Library/Java/JavaVirtualMachines"} <= roots)
        linux = {str(root.path) for root in subject.defaultRoots({}, self.root, "linux")}
        self.assertIn("/usr/lib/jvm", linux)
        self.assertIn("/opt/android-studio", linux)

    def testScanFindsNestedHomesAndAliasesWithoutFollowingCycles(self):
        home, _ = self.makeJava("manager/installs/java/25")
        (self.root / "alias").symlink_to(home, target_is_directory=True)
        (self.root / "cycle").symlink_to(self.root, target_is_directory=True)
        discovery = subject.Discovery()
        subject.scanRoot(subject.SearchRoot(self.root), discovery)
        self.assertEqual(discovery.homes, {home})
        self.assertEqual(discovery.errors, [])

    def testIdeBundlesAndGradleAndToolcacheLayouts(self):
        home, _ = self.makeJava("Android Studio.app/Contents/jbr/Contents/Home")
        gradle, _ = self.makeJava("gradle/jdks/vendor-21/Contents/Home")
        cache, _ = self.makeJava("toolcache/Java_Temurin-Hotspot_jdk/25/x64")
        discovery = subject.Discovery()
        subject.scanRoot(subject.SearchRoot(self.root), discovery)
        self.assertEqual(discovery.homes, {home, gradle, cache})

    def testAllPathEntriesAndConfiguredHomeAreDiscoveredButShimsAreNotRun(self):
        first, _ = self.makeJava("first")
        second, _ = self.makeJava("second")
        shim = self.root / "shims"
        shim.mkdir()
        (shim / "java").write_text("Do not execute this shim")
        environment = {"PATH": os.pathsep.join(map(str, (first / "bin", second / "bin", shim))),
                       "JAVA_HOME": str(first)}
        with mock.patch.object(subject, "defaultRoots", return_value=[]):
            discovery = subject.discoverInstallations(environment, self.root, "linux", [])
        self.assertEqual(discovery.homes, {first, second})
        self.assertTrue(any("shim" in item["reason"] for item in discovery.skipped))

    def testMissingRequiredRootsAndAccessErrorsAreReported(self):
        discovery = subject.Discovery()
        subject.scanRoot(subject.SearchRoot(self.root / "optional"), discovery)
        self.assertEqual(discovery.errors, [])
        subject.scanRoot(subject.SearchRoot(self.root / "required", required=True), discovery)
        self.assertEqual(len(discovery.errors), 1)
        with mock.patch.object(subject.os, "scandir", side_effect=PermissionError(errno.EACCES, "denied")):
            subject.scanRoot(subject.SearchRoot(self.root), discovery)
        self.assertEqual(len(discovery.errors), 2)

    def testDepthLimitsAreReported(self):
        home, _ = self.makeJava("nested/deeper/jdk")
        discovery = subject.Discovery()
        subject.scanRoot(subject.SearchRoot(self.root, depth=1), discovery)
        self.assertNotIn(home, discovery.homes)
        self.assertTrue(any(item["reason"] == "search depth limit" for item in discovery.skipped))

    def testMacRegistryUsesStructuredPlistAndDoesNotRunJavaStub(self):
        home, _ = self.makeJava()
        response = subprocess.CompletedProcess([], 0, plistlib.dumps([{"JVMHomePath": str(home)}]), b"")
        with mock.patch.object(subject, "defaultRoots", return_value=[]):
            with mock.patch.object(subject.Path, "is_file", return_value=True):
                with mock.patch.object(subject.subprocess, "run", return_value=response) as run:
                    discovery = subject.discoverInstallations({}, self.root, "darwin", [])
        self.assertEqual(discovery.homes, {home})
        self.assertEqual(run.call_args.args[0], ["/usr/libexec/java_home", "-X"])


class CliTests(FixtureTest):
    def testJavaHomeEnvironmentDefault(self):
        home, _ = self.makeJava()
        with mock.patch.dict(os.environ, {"JAVA_HOME": str(home)}):
            status, output, _ = self.invoke(["--apply", "--json"])
        self.assertEqual(status, 0)
        self.assertEqual(json.loads(output)["runtimes"][0]["added"], 16)

    def testAllModeScansCustomRootsAndPatchesEveryRuntime(self):
        first, firstTarget = self.makeJava("first", "1.8")
        second, secondTarget = self.makeJava("second")
        (self.root / "alias").symlink_to(first, target_is_directory=True)
        with mock.patch.dict(os.environ, {"PATH": ""}, clear=True):
            with mock.patch.object(subject, "defaultRoots", return_value=[]):
                with mock.patch.object(subject.sys, "platform", "linux"):
                    status, output, _ = self.invoke(["--all", "--search-root", str(self.root), "--apply", "--json"])
        self.assertEqual(status, 0)
        report = json.loads(output)
        self.assertEqual(len(report["runtimes"]), 2)
        self.assertEqual(sum(entry["added"] for entry in report["runtimes"]), 32)
        self.assertEqual(report["searched_roots"], [str(self.root)])
        for target in (firstTarget, secondTarget):
            self.assertTrue(set(FINGERPRINTS).issubset(subject.blockedFingerprints(target.read_bytes())))

    def testDefaultDryRunAndExplicitApply(self):
        home, target = self.makeJava("jdk with spaces and $(echo unsafe)")
        status, output, _ = self.invoke(["--java-home", str(home), "--json"])
        self.assertEqual(status, 0)
        self.assertEqual(json.loads(output)["mode"], "dry-run")
        self.assertEqual(target.read_bytes(), VENDOR)
        status, output, _ = self.invoke(["--java-home", str(home), "--apply", "--json"])
        self.assertEqual(status, 0)
        self.assertEqual(json.loads(output)["runtimes"][0]["added"], 16)

    def testSearchFailuresProduceNonzeroStatusAfterProcessingFoundJvm(self):
        home, target = self.makeJava()
        discovery = subject.Discovery(homes={home}, errors=["Unreadable search root"])
        with mock.patch.object(subject, "discoverInstallations", return_value=discovery):
            status, output, _ = self.invoke(["--all", "--apply", "--json"])
        self.assertEqual(status, 1)
        self.assertEqual(json.loads(output)["runtimes"][0]["status"], "patched")
        self.assertNotEqual(target.read_bytes(), VENDOR)

    def testEmptyDiscoveryIsNotReportedAsProtection(self):
        with mock.patch.object(subject, "discoverInstallations", return_value=subject.Discovery()):
            status, output, _ = self.invoke(["--all", "--json"])
        self.assertEqual(status, 1)
        self.assertIn("No Java installations", json.loads(output)["errors"][0])

    def testRefusesScanningAsRoot(self):
        with mock.patch.object(subject.os, "geteuid", return_value=0):
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                subject.main(["--all"])

    def testDryRunNeverElevatesAndApplyElevatesOnlyFileUpdate(self):
        target = self.root / "blocklist"
        with mock.patch.object(subject, "updateBlocklist", side_effect=PermissionError):
            with mock.patch.object(subject.subprocess, "run") as run:
                with self.assertRaises(PermissionError):
                    subject.patchWithElevation(target, FINGERPRINTS, False, True)
                run.assert_not_called()
                run.return_value = subprocess.CompletedProcess([], 0, '{"status":"patched","added":16}')
                result = subject.patchWithElevation(target, FINGERPRINTS, True, True)
        command = run.call_args.args[0]
        self.assertEqual(command[:2], ["sudo", "-n"])
        self.assertIn("-I", command)
        self.assertEqual(command[-2:], ["--update-blocklist", str(target)])
        self.assertNotIn("--all", command)
        self.assertEqual(result["added"], 16)

    def testInternalWorkerCannotOverrideDryRun(self):
        target = self.root / "vendor.certs"
        target.write_bytes(VENDOR)
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            subject.main(["--update-blocklist", str(target), "--dry-run"])
        self.assertEqual(target.read_bytes(), VENDOR)

    def testImportDoesNotExecuteTheScript(self):
        result = subprocess.run([sys.executable, "-c", "import blockCompromisedJavaCertificates"],
                                cwd=subject.SCRIPT.parent, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, b"")
        self.assertEqual(result.stderr, b"")


if __name__ == "__main__":
    unittest.main()
