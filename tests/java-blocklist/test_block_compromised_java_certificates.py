"""
Exercise Java discovery and blocklist updates using isolated, synthetic installations.
"""
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

# Import the standalone script without requiring an installed package.
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import blockCompromisedJavaCertificates as subject

BUNDLE = subject.CERTIFICATES.read_text(encoding='ascii')
FINGERPRINTS = subject.certificateFingerprints(BUNDLE)
VENDOR = b'Algorithm=SHA-256\n# Preserve vendor entries\n' + b'F' * 64 + b'\n'


class FixtureTest(unittest.TestCase):
    """
    Provide disposable filesystem fixtures and a non-root CLI harness.
    """
    def setUp(self):
        """
        Create a temporary fixture directory that is removed after each test.
        """
        self.temporary = tempfile.TemporaryDirectory(prefix='java-blocklist-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()

    def makeJava(self, name='jdk', specification='25', runtimeHome=None):
        """
        Create a fake Java launcher and vendor blocklist with the requested runtime layout.
        """
        home = self.root / name
        runtime = runtimeHome or (home / 'jre' if specification == '1.8' else home)
        (home / 'bin').mkdir(parents=True)
        (home / 'release').write_text('IMPLEMENTOR="Fixture"\n')
        properties = (
            f'    java.home = {runtime}\n    java.specification.version = {specification}\n'
            '    java.vendor = Fixture vendor\n    java.runtime.version = Fixture version\n'
        )
        java = home / 'bin/java'
        java.write_text(f"#!/bin/sh\nprintf '%s' {shlex.quote(properties)}\n")
        java.chmod(0o755)
        security = runtime / 'lib/security'
        security.mkdir(parents=True, exist_ok=True)
        target = security / ('blacklisted.certs' if specification == '1.8' else 'blocked.certs')
        if not target.exists():
            target.write_bytes(VENDOR)

        return home, target

    def invoke(self, arguments):
        """
        Run the CLI as a simulated normal user and capture its status and output streams.
        """
        output, errors = io.StringIO(), io.StringIO()
        with mock.patch.object(target=subject.os, attribute='geteuid', return_value=1000):
            with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
                status = subject.main(arguments)

        return status, output.getvalue(), errors.getvalue()


class CertificateTests(unittest.TestCase):
    """
    Check the committed certificate policy and rejection of invalid bundles.
    """
    def testCommittedSnapshot(self):
        """
        Verify the snapshot produces 16 unique uppercase certificate fingerprints.
        """
        self.assertEqual(len(FINGERPRINTS), 16)
        self.assertEqual(len(set(FINGERPRINTS)), 16)
        self.assertEqual(FINGERPRINTS[0], '42C4ACCD12C4F59597925E1A08A7A90102608543809308D50EC427E118BA1493')
        for fingerprint in FINGERPRINTS:
            self.assertRegex(fingerprint, r'^[0-9A-F]{64}$')

    def testMalformedMissingDuplicateAndExtraCertificates(self):
        """
        Reject malformed, incomplete, duplicated, or unexpected certificate data.
        """
        certificates = subject.re.findall(
            pattern=r'-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----',
            string=BUNDLE,
            flags=subject.re.DOTALL,
        )
        for bundle in ('bad', '\n'.join(certificates[1:]), '\n'.join([certificates[0]] * 16), BUNDLE + 'extra'):
            with self.subTest(bundle=bundle[:40]):
                with self.assertRaises(ValueError):
                    subject.certificateFingerprints(bundle)

        badDer = base64.b64encode(b'bad').decode()
        bad = f'-----BEGIN CERTIFICATE-----\n{badDer}\n-----END CERTIFICATE-----'
        with self.assertRaises(ValueError):
            subject.certificateFingerprints('\n'.join([bad] + certificates[1:]))


class PropertyTests(unittest.TestCase):
    """
    Verify the supported Java Properties syntax and fail-closed parsing rules.
    """
    def testJavaPropertySeparators(self):
        """
        Accept literal property separators and whitespace recognized by Java.
        """
        for algorithm in ('Algorithm=SHA-256', 'Algorithm : SHA-256', '\tAlgorithm\fSHA-256'):
            for separator in ('', '=', ':ignored', ' ignored', '\tignored'):
                content = f'{algorithm}\r\n  {FINGERPRINTS[0]}{separator}\r\n'.encode()
                self.assertEqual(subject.blockedFingerprints(content), {FINGERPRINTS[0]})

    def testCommentsLowercaseAndPartialKeysDoNotCount(self):
        """
        Exclude comments and keys that do not match uppercase certificate fingerprints.
        """
        content = (
            f'Algorithm=SHA-256\n# {FINGERPRINTS[0]}\n !{FINGERPRINTS[1]}\n'
            f'{FINGERPRINTS[2].lower()}\n{FINGERPRINTS[3][1:]}\n'
        ).encode()
        self.assertEqual(subject.blockedFingerprints(content), set())

    def testUnicodeLineSeparatorsAreNotJavaNewlines(self):
        """
        Keep non-Java Unicode line separators inside their original property lines.
        """
        content = f'Algorithm=SHA-256\n# Not a new line\x85{FINGERPRINTS[0]}\n'.encode('latin1')
        self.assertEqual(subject.blockedFingerprints(content), set())

    def testUnsupportedPropertiesFailClosed(self):
        """
        Reject unsupported algorithms, overrides, byte-order marks, escapes, and continuations.
        """
        for content in (
            b'',
            b'Algorithm=SHA-512\n',
            b'Algorithm==SHA-256\n',
            b'Algorithm=SHA-256 \n',
            b'Algorithm=SHA-256\nAlgorithm=SHA-256\n',
            b'Algorithm=SHA-256\nAlgorithm SHA-512\n',
            b'Algorithm=SHA-256\nAlgorithm\n',
            b'\xef\xbb\xbfAlgorithm=SHA-256\n',
            b'Algorithm=SHA-256\nAlgorith\\u006d=SHA-512\n',
            b'Algorithm=SHA-256\nother=continued\\\n',
        ):
            with self.subTest(content=content), self.assertRaises(ValueError):
                subject.blockedFingerprints(content)


class UpdateTests(FixtureTest):
    """
    Check dry-run, append-only updates, metadata preservation, and idempotence.
    """
    def setUp(self):
        """
        Create an existing vendor blocklist with controlled contents and permissions.
        """
        super().setUp()
        self.target = self.root / 'vendor.certs'
        self.target.write_bytes(VENDOR)
        self.target.chmod(0o640)

    def testDryRunNeverWrites(self):
        """
        Report missing entries without changing the blocklist bytes or modification time.
        """
        before = self.target.stat()
        result = subject.updateBlocklist(self.target, FINGERPRINTS)
        self.assertEqual(result, {'status': 'would-patch', 'missing': 16, 'added': 0})
        self.assertEqual(self.target.read_bytes(), VENDOR)
        self.assertEqual(self.target.stat().st_mtime_ns, before.st_mtime_ns)

    def testAppendPreservesVendorBytesMetadataAndSymlink(self):
        """
        Append all missing entries without replacing the file or disturbing its aliases.
        """
        before = self.target.stat()
        link = self.root / 'vendor link'
        link.symlink_to(self.target)
        result = subject.updateBlocklist(target=link.resolve(), fingerprints=FINGERPRINTS, apply=True)
        self.assertEqual(result['added'], 16)
        self.assertTrue(self.target.read_bytes().startswith(VENDOR))
        self.assertTrue(set(FINGERPRINTS).issubset(subject.blockedFingerprints(self.target.read_bytes())))
        self.assertTrue(link.is_symlink())
        for field in ('st_mode', 'st_uid', 'st_gid', 'st_ino', 'st_dev'):
            self.assertEqual(getattr(before, field), getattr(self.target.stat(), field))

    def testReadOnlyIdempotence(self):
        """
        Verify an already-protected read-only blocklist without requesting write access.
        """
        subject.updateBlocklist(target=self.target, fingerprints=FINGERPRINTS, apply=True)
        self.target.chmod(0o400)
        before = self.target.stat()
        content = self.target.read_bytes()
        result = subject.updateBlocklist(target=self.target, fingerprints=FINGERPRINTS, apply=True)
        self.assertEqual(result['status'], 'already-protected')
        self.assertEqual(self.target.read_bytes(), content)
        self.assertEqual(self.target.stat().st_mtime_ns, before.st_mtime_ns)

    def testPartialAndKeyValueEntries(self):
        """
        Count active key-value entries but append hashes found only in comments or lowercase.
        """
        content = VENDOR + f'{FINGERPRINTS[0]}=\n#{FINGERPRINTS[1]}\n{FINGERPRINTS[2].lower()}\n'.encode()
        self.target.write_bytes(content)
        self.assertEqual(subject.updateBlocklist(self.target, FINGERPRINTS, True)['added'], 15)

    def testLineEndingsAndLiteralPaths(self):
        """
        Preserve original line endings and treat shell metacharacters in paths literally.
        """
        target = self.root / "vendor ' $(echo unsafe).certs"
        for ending in (b'', b'\r', b'\r\n'):
            original = b'Algorithm=SHA-256\r\n# Vendor comment' + ending
            target.write_bytes(original)
            self.assertEqual(subject.updateBlocklist(target, FINGERPRINTS, True)['added'], 16)
            self.assertTrue(target.read_bytes().startswith(original))

    def testMalformedAndMissingFilesAreNotChangedOrCreated(self):
        """
        Leave malformed files untouched and never create a missing vendor blocklist.
        """
        for content in (b'Algorithm=SHA-512\n', b'Algorithm=SHA-256\nother=continued\\\n'):
            self.target.write_bytes(content)
            with self.assertRaises(ValueError):
                subject.updateBlocklist(self.target, FINGERPRINTS, True)
            self.assertEqual(self.target.read_bytes(), content)

        missing = self.root / 'missing'
        with self.assertRaises(FileNotFoundError):
            subject.updateBlocklist(missing, FINGERPRINTS, True)
        self.assertFalse(missing.exists())


class RuntimeTests(FixtureTest):
    """
    Check executable inspection, blocklist resolution, deduplication, and partial failures.
    """
    def testActualRuntimeHomeVersionsAndLayouts(self):
        """
        Resolve each reported runtime home across Java 8 and modern JDK layouts.
        """
        for version in ('1.8', '11', '17', '21', '25'):
            home, target = self.makeJava(f'jdk{version}', version)
            runtime = subject.inspectRuntime(home)
            self.assertEqual(subject.resolveBlocklist(runtime['home']), target)

    def testAmbiguousOrMissingBlocklistFails(self):
        """
        Reject runtime directories with multiple blocklist candidates or none.
        """
        home, target = self.makeJava()
        (target.parent / 'blacklisted.certs').write_bytes(VENDOR)
        with self.assertRaises(ValueError):
            subject.resolveBlocklist(home)

        target.unlink()
        (target.parent / 'blacklisted.certs').unlink()
        with self.assertRaises(ValueError):
            subject.resolveBlocklist(home)

    def testRuntimeHomePreservesTrailingSpaces(self):
        """
        Preserve significant whitespace in the reported runtime path when parsing properties.
        """
        home, _ = self.makeJava('jdk with trailing space ')
        self.assertEqual(subject.inspectRuntime(home)['home'], home)

    def testInvalidJavaSpecificationsAreRejected(self):
        """
        Reject malformed major versions rather than accepting partial numeric prefixes.
        """
        for index, specification in enumerate(('', '-1', '1.8.0', '8.0', '25-ea', 'unknown')):
            home, _ = self.makeJava(name=f'invalid-{index}', specification=specification)
            with self.assertRaises(ValueError):
                subject.inspectRuntime(home)

    def testInspectionFailuresDoNotLeakJvmDiagnostics(self):
        """
        Hide captured secret-bearing diagnostics when Java inspection fails.
        """
        home, target = self.makeJava()
        java = home / 'bin/java'
        java.write_text("#!/bin/sh\necho 'JAVA_TOOL_OPTIONS: SECRET_SENTINEL' >&2\nexit 1\n")
        runtimes, blocklists = subject.run([home], FINGERPRINTS, True, True)
        self.assertEqual(runtimes[0]['status'], 'failed')
        self.assertEqual(blocklists, [])
        self.assertNotIn('SECRET_SENTINEL', json.dumps(runtimes))
        self.assertEqual(target.read_bytes(), VENDOR)

    def testUnsupportedVersionAndProperties(self):
        """
        Reject old Java versions and incomplete properties without exposing diagnostics.
        """
        home, _ = self.makeJava(specification='1.7')
        with self.assertRaisesRegex(ValueError, 'Java 8'):
            subject.inspectRuntime(home)

        response = subprocess.CompletedProcess([], 0, b'java.home = relative\n', b'SECRET_SENTINEL')
        with mock.patch.object(target=subject.subprocess, attribute='run', return_value=response):
            with self.assertRaises(ValueError) as raised:
                subject.inspectRuntime(home)
            self.assertNotIn('SECRET_SENTINEL', str(raised.exception))

    def testRuntimeAndSharedBlocklistDeduplication(self):
        """
        Resolve aliases to a set of blocklist paths and collect all runtimes before writing.
        """
        home, target = self.makeJava('first')
        alias, _ = self.makeJava(name='alias', runtimeHome=home)
        runtimes, blocklists = subject.run([home, alias], FINGERPRINTS, False, True)
        self.assertEqual(len(runtimes), 1)
        self.assertEqual(len(blocklists), 1)
        second, secondTarget = self.makeJava('second')
        secondTarget.unlink()
        secondTarget.symlink_to(target)
        inspectRuntime = subject.inspectRuntime

        def inspectBeforeWriting(candidate):
            """
            Verify collection does not mutate blocklists while inspecting additional runtimes.
            """
            self.assertEqual(target.read_bytes(), VENDOR)
            return inspectRuntime(candidate)

        with mock.patch.object(target=subject, attribute='inspectRuntime', side_effect=inspectBeforeWriting):
            with mock.patch.object(
                target=subject, attribute='patchWithElevation', wraps=subject.patchWithElevation
            ) as patch:
                runtimes, blocklists = subject.run([home, second], FINGERPRINTS, True, True)

        self.assertEqual(len(runtimes), 2)
        self.assertEqual(len(blocklists), 1)
        self.assertEqual(blocklists[0]['status'], 'patched')
        self.assertEqual(blocklists[0]['added'], 16)
        patch.assert_called_once()

    def testHardLinkedBlocklistsRemainIdempotent(self):
        """
        Process distinct hard-link paths safely without separate inode bookkeeping.
        """
        first, target = self.makeJava('first')
        second, secondTarget = self.makeJava('second')
        secondTarget.unlink()
        os.link(target, secondTarget)
        _, blocklists = subject.run([first, second], FINGERPRINTS, True, True)
        self.assertEqual([entry['status'] for entry in blocklists], ['patched', 'already-protected'])
        self.assertEqual(sum(entry['added'] for entry in blocklists), 16)

    def testPartialFailureStillProcessesOtherJvms(self):
        """
        Continue protecting valid installations after another candidate fails inspection.
        """
        home, target = self.makeJava()
        runtimes, blocklists = subject.run([self.root / 'absent', home], FINGERPRINTS, True, True)
        self.assertEqual([entry['status'] for entry in runtimes], ['failed', 'discovered'])
        self.assertEqual(blocklists[0]['status'], 'patched')
        self.assertEqual(len(set(FINGERPRINTS) & subject.blockedFingerprints(target.read_bytes())), 16)

    def testFailedFileUpdateDoesNotStopOtherFiles(self):
        """
        Retain a failed file update while continuing with the other collected blocklists.
        """
        first, firstTarget = self.makeJava('first')
        second, secondTarget = self.makeJava('second')
        update = subject.patchWithElevation

        def failFirst(target, fingerprints, apply, nonInteractive):
            """
            Simulate a failure for one target without changing the other update's behavior.
            """
            if target == firstTarget:
                raise ValueError('Fixture update failure')

            return update(target, fingerprints, apply, nonInteractive)

        with mock.patch.object(target=subject, attribute='patchWithElevation', side_effect=failFirst):
            _, blocklists = subject.run([first, second], FINGERPRINTS, True, True)

        self.assertEqual([entry['status'] for entry in blocklists], ['failed', 'patched'])
        self.assertTrue(set(FINGERPRINTS).issubset(subject.blockedFingerprints(secondTarget.read_bytes())))


class DiscoveryTests(FixtureTest):
    """
    Check discovery providers, bounded traversal, skipped launchers, and access reporting.
    """
    def testKnownSourcesIncludeOverridesAndPlatformLocations(self):
        """
        Include configured manager directories and the expected platform-specific roots.
        """
        environment = {
            'SDKMAN_DIR': '/custom/sdkman',
            'ASDF_DATA_DIR': '/custom/asdf',
            'MISE_DATA_DIR': '/custom/mise',
            'JENV_ROOT': '/custom/jenv',
            'GRADLE_USER_HOME': '/custom/gradle',
            'RUNNER_TOOL_CACHE': '/custom/toolcache',
        }
        roots = {str(root.path) for root in subject.defaultRoots(environment, self.root, 'darwin')}
        self.assertTrue(
            {
                '/custom/sdkman/candidates/java',
                '/custom/asdf/installs/java',
                '/custom/mise/installs/java',
                '/custom/jenv/versions',
                '/custom/gradle/jdks',
                '/custom/toolcache',
                '/Applications',
                '/Library/Java/JavaVirtualMachines',
            }
            <= roots
        )
        linux = {str(root.path) for root in subject.defaultRoots({}, self.root, 'linux')}
        self.assertIn('/usr/lib/jvm', linux)
        self.assertIn('/opt/android-studio', linux)

    def testScanFindsNestedHomesAndAliasesWithoutFollowingCycles(self):
        """
        Find nested installations while deduplicating aliases and terminating symlink cycles.
        """
        home, _ = self.makeJava('manager/installs/java/25')
        (self.root / 'alias').symlink_to(target=home, target_is_directory=True)
        (self.root / 'cycle').symlink_to(target=self.root, target_is_directory=True)
        discovery = subject.Discovery()
        subject.scanRoot(subject.SearchRoot(self.root), discovery)
        self.assertEqual(discovery.homes, {home})
        self.assertEqual(discovery.errors, [])

    def testIdeBundlesAndGradleAndToolcacheLayouts(self):
        """
        Recognize embedded IDE runtimes, Gradle downloads, and CI tool-cache layouts.
        """
        home, _ = self.makeJava('Android Studio.app/Contents/jbr/Contents/Home')
        gradle, _ = self.makeJava('gradle/jdks/vendor-21/Contents/Home')
        cache, _ = self.makeJava('toolcache/Java_Temurin-Hotspot_jdk/25/x64')
        discovery = subject.Discovery()
        subject.scanRoot(subject.SearchRoot(self.root), discovery)
        self.assertEqual(discovery.homes, {home, gradle, cache})

    def testAllPathEntriesAndConfiguredHomeAreDiscoveredButShimsAreNotRun(self):
        """
        Inspect every configured PATH launcher while excluding non-runtime shims.
        """
        first, _ = self.makeJava('first')
        second, _ = self.makeJava('second')
        shim = self.root / 'shims'
        shim.mkdir()
        (shim / 'java').write_text('Do not execute this shim')
        environment = {
            'PATH': os.pathsep.join(map(str, (first / 'bin', second / 'bin', shim))),
            'JAVA_HOME': str(first),
        }
        with mock.patch.object(target=subject, attribute='defaultRoots', return_value=[]):
            discovery = subject.discoverInstallations(environment, self.root, 'linux', [])
        self.assertEqual(discovery.homes, {first, second})
        self.assertTrue(any('shim' in item['reason'] for item in discovery.skipped))

    def testMissingRequiredRootsAndAccessErrorsAreReported(self):
        """
        Distinguish absent optional roots from required-root and permission failures.
        """
        discovery = subject.Discovery()
        subject.scanRoot(subject.SearchRoot(self.root / 'optional'), discovery)
        self.assertEqual(discovery.errors, [])
        subject.scanRoot(subject.SearchRoot(path=self.root / 'required', required=True), discovery)
        self.assertEqual(len(discovery.errors), 1)
        with mock.patch.object(
            target=subject.os, attribute='scandir', side_effect=PermissionError(errno.EACCES, 'denied')
        ):
            subject.scanRoot(subject.SearchRoot(self.root), discovery)
        self.assertEqual(len(discovery.errors), 2)

    def testDepthLimitsAreReported(self):
        """
        Report directories beyond the traversal bound without claiming they were searched.
        """
        home, _ = self.makeJava('nested/deeper/jdk')
        discovery = subject.Discovery()
        subject.scanRoot(subject.SearchRoot(path=self.root, depth=1), discovery)
        self.assertNotIn(home, discovery.homes)
        self.assertTrue(any(item['reason'] == 'search depth limit' for item in discovery.skipped))

    def testMacRegistryUsesStructuredPlistAndDoesNotRunJavaStub(self):
        """
        Read macOS registry metadata through java_home rather than executing its Java stub.
        """
        home, _ = self.makeJava()
        response = subprocess.CompletedProcess([], 0, plistlib.dumps([{'JVMHomePath': str(home)}]), b'')
        with mock.patch.object(target=subject, attribute='defaultRoots', return_value=[]):
            with mock.patch.object(target=subject.Path, attribute='is_file', return_value=True):
                with mock.patch.object(target=subject.subprocess, attribute='run', return_value=response) as run:
                    discovery = subject.discoverInstallations({}, self.root, 'darwin', [])
        self.assertEqual(discovery.homes, {home})
        self.assertEqual(run.call_args.kwargs['args'], ['/usr/libexec/java_home', '-X'])


class CliTests(FixtureTest):
    """
    Exercise CLI defaults, discovery scope, reporting, privilege boundaries, and import safety.
    """
    def testJavaHomeEnvironmentDefault(self):
        """
        Use JAVA_HOME when no explicit installation or discovery mode is supplied.
        """
        home, _ = self.makeJava()
        with mock.patch.dict(os.environ, {'JAVA_HOME': str(home)}):
            status, output, _ = self.invoke(['--apply', '--json'])
        self.assertEqual(status, 0)
        self.assertEqual(json.loads(output)['blocklists'][0]['added'], 16)

    def testAllModeScansCustomRootsAndPatchesEveryRuntime(self):
        """
        Patch all distinct fixture runtimes discovered under an explicit extra root.
        """
        first, firstTarget = self.makeJava('first', '1.8')
        second, secondTarget = self.makeJava('second')
        (self.root / 'alias').symlink_to(target=first, target_is_directory=True)
        with mock.patch.dict(in_dict=os.environ, values={'PATH': ''}, clear=True):
            with mock.patch.object(target=subject, attribute='defaultRoots', return_value=[]):
                with mock.patch.object(subject.sys, 'platform', 'linux'):
                    status, output, _ = self.invoke(['--all', '--search-root', str(self.root), '--apply', '--json'])
        self.assertEqual(status, 0)
        report = json.loads(output)
        self.assertEqual(len(report['runtimes']), 2)
        self.assertEqual(len(report['blocklists']), 2)
        self.assertEqual(sum(entry['added'] for entry in report['blocklists']), 32)
        self.assertEqual(report['searched_roots'], [str(self.root)])
        for target in (firstTarget, secondTarget):
            self.assertTrue(set(FINGERPRINTS).issubset(subject.blockedFingerprints(target.read_bytes())))

    def testDefaultDryRunAndExplicitApply(self):
        """
        Require explicit apply mode before modifying a selected installation.
        """
        home, target = self.makeJava('jdk with spaces and $(echo unsafe)')
        status, output, _ = self.invoke(['--java-home', str(home), '--json'])
        self.assertEqual(status, 0)
        self.assertEqual(json.loads(output)['mode'], 'dry-run')
        self.assertEqual(target.read_bytes(), VENDOR)
        status, output, _ = self.invoke(['--java-home', str(home), '--apply', '--json'])
        self.assertEqual(status, 0)
        self.assertEqual(json.loads(output)['blocklists'][0]['added'], 16)

    def testSearchFailuresProduceNonzeroStatusAfterProcessingFoundJvm(self):
        """
        Return failure for incomplete discovery even after successfully patching a found JVM.
        """
        home, target = self.makeJava()
        discovery = subject.Discovery(homes={home}, errors=['Unreadable search root'])
        with mock.patch.object(target=subject, attribute='discoverInstallations', return_value=discovery):
            status, output, _ = self.invoke(['--all', '--apply', '--json'])
        self.assertEqual(status, 1)
        self.assertEqual(json.loads(output)['blocklists'][0]['status'], 'patched')
        self.assertNotEqual(target.read_bytes(), VENDOR)

    def testEmptyDiscoveryIsNotReportedAsProtection(self):
        """
        Return a nonzero status when discovery finds no installations to inspect.
        """
        with mock.patch.object(target=subject, attribute='discoverInstallations', return_value=subject.Discovery()):
            status, output, _ = self.invoke(['--all', '--json'])
        self.assertEqual(status, 1)
        self.assertIn('No Java installations', json.loads(output)['errors'][0])

    def testRefusesScanningAsRoot(self):
        """
        Reject whole-process root execution before inspecting discovered Java executables.
        """
        with mock.patch.object(target=subject.os, attribute='geteuid', return_value=0):
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                subject.main(['--all'])

    def testDryRunNeverElevatesAndApplyElevatesOnlyFileUpdate(self):
        """
        Keep dry-run unprivileged and limit sudo retries to the isolated file-update worker.
        """
        target = self.root / 'blocklist'
        with mock.patch.object(target=subject, attribute='updateBlocklist', side_effect=PermissionError):
            with mock.patch.object(subject.subprocess, 'run') as run:
                with self.assertRaises(PermissionError):
                    subject.patchWithElevation(target, FINGERPRINTS, False, True)

                run.assert_not_called()
                run.return_value = subprocess.CompletedProcess([], 0, '{"status":"patched","added":16}')
                result = subject.patchWithElevation(target, FINGERPRINTS, True, True)
        command = run.call_args.kwargs['args']
        self.assertEqual(command[:2], ['sudo', '-n'])
        self.assertIn('-I', command)
        self.assertEqual(command[-2:], ['--update-blocklist', str(target)])
        self.assertNotIn('--all', command)
        self.assertEqual(result['added'], 16)

    def testInternalWorkerCannotOverrideDryRun(self):
        """
        Reject extra worker arguments rather than let the private mode bypass a dry-run request.
        """
        target = self.root / 'vendor.certs'
        target.write_bytes(VENDOR)
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            subject.main(['--update-blocklist', str(target), '--dry-run'])
        self.assertEqual(target.read_bytes(), VENDOR)

    def testImportDoesNotExecuteTheScript(self):
        """
        Import the module without executing its CLI or producing output.
        """
        result = subprocess.run(
            args=[sys.executable, '-c', 'import blockCompromisedJavaCertificates'],
            cwd=subject.SCRIPT.parent,
            capture_output=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, b'')
        self.assertEqual(result.stderr, b'')


if __name__ == '__main__':
    unittest.main()
