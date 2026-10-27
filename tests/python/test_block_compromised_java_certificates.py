"""
Test blocklist behavior and CLI outcomes using isolated Java installations.
"""
import contextlib
import errno
import io
import json
import os
import plistlib
import re
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
PEMS = re.findall(r'-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----', BUNDLE, re.DOTALL)
VENDOR = b'Algorithm=SHA-256\n# Preserve vendor entries\n' + b'F' * 64 + b'\n'


class FixtureTest(unittest.TestCase):
    """
    Provide temporary files, fake Java launchers, and a CLI harness isolated from the real machine.
    """
    def setUp(self):
        """
        Create disposable files and default to headless execution.
        """
        temporary = tempfile.TemporaryDirectory(prefix='java-blocklist-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        terminal = mock.patch.object(target=sys.stdin, attribute='isatty', return_value=False)
        terminal.start()
        self.addCleanup(terminal.stop)

    def makeJava(self, name='jdk', specification='25', runtimeHome=None):
        """
        Create a launcher reporting the requested runtime home and its vendor blocklist.
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
        Capture CLI results as a normal user, without changing the real process privileges.
        """
        output, errors = io.StringIO(), io.StringIO()
        with mock.patch.object(target=subject.os, attribute='geteuid', return_value=1000):
            with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
                status = subject.main(arguments)

        return status, output.getvalue(), errors.getvalue()

    def invokeAll(self, root, arguments):
        """
        Limit discovery to fixture roots so apply tests cannot touch installed Java runtimes.
        """
        with mock.patch.dict(in_dict=os.environ, values={'PATH': ''}, clear=True):
            with mock.patch.object(target=subject, attribute='defaultRoots', return_value=[]):
                with mock.patch.object(subject.sys, 'platform', 'linux'):
                    return self.invoke(['--all', '--search-root', str(root), *arguments])

    def openReadOnly(self, path, mode='r', *args, **kwargs):
        """
        Simulate denied writes at the filesystem boundary while allowing ordinary reads.
        """
        if any(flag in mode for flag in 'wax+'):
            raise PermissionError(errno.EACCES, 'Fixture write denied')

        return io.open(path, mode, *args, **kwargs)


class PolicyTests(unittest.TestCase):
    """
    Check certificate fingerprint correctness and policy-size independence.
    """
    def testFingerprintsAndGrowingPolicy(self):
        """
        Match a known certificate hash and accept changes to the number of bundled certificates.
        """
        known = '42C4ACCD12C4F59597925E1A08A7A90102608543809308D50EC427E118BA1493'
        self.assertIn(known, FINGERPRINTS)
        self.assertEqual(len(subject.certificateFingerprints(BUNDLE + PEMS[0])), len(PEMS) + 1)

    def testEmptyPolicyIsRejected(self):
        """
        Do not report protection from a policy with no certificates.
        """
        with self.assertRaises(ValueError):
            subject.certificateFingerprints('')


class BlocklistTests(FixtureTest):
    """
    Check file contents, safe dry-runs, idempotence, and privileged-write behavior.
    """
    def setUp(self):
        """
        Use a vendor file whose path contains spaces and shell metacharacters.
        """
        super().setUp()
        self.target = self.root / "vendor ' $(echo unsafe).certs"
        self.target.write_bytes(VENDOR)
        self.target.chmod(0o640)

    def testDryRunDoesNotWriteOrRequestSudo(self):
        """
        Report missing entries without changing files or starting a privileged command.
        """
        with mock.patch.object(subject.subprocess, 'run') as sudo:
            result = subject.updateBlocklist(self.target, FINGERPRINTS)

        self.assertEqual(result.status, 'would-patch')
        self.assertEqual(result.missing, len(FINGERPRINTS))
        self.assertEqual(self.target.read_bytes(), VENDOR)
        sudo.assert_not_called()

    def testApplyPreservesVendorDataAndPermissions(self):
        """
        Add the policy while retaining existing contents and access permissions.
        """
        before = self.target.stat()
        result = subject.updateBlocklist(self.target, FINGERPRINTS, True)
        content = self.target.read_bytes()
        self.assertEqual(result.added, len(FINGERPRINTS))
        self.assertTrue(content.startswith(VENDOR))
        self.assertTrue(set(FINGERPRINTS).issubset(subject.blockedFingerprints(content)))
        self.assertEqual(self.target.stat().st_mode, before.st_mode)

    def testProtectedReadOnlyFileNeedsNoWriteOrSudo(self):
        """
        Make repeat apply runs harmless even when the already-protected file is read-only.
        """
        subject.updateBlocklist(self.target, FINGERPRINTS, True)
        self.target.chmod(0o400)
        content = self.target.read_bytes()
        with mock.patch.object(subject.subprocess, 'run') as sudo:
            result = subject.updateBlocklist(self.target, FINGERPRINTS, True)

        self.assertEqual(result.status, 'already-protected')
        self.assertEqual(result.added, 0)
        self.assertEqual(self.target.read_bytes(), content)
        sudo.assert_not_called()

    def testOnlyActiveKeysCountAsExistingBlocks(self):
        """
        Keep valid key-value entries but do not mistake comments or lowercase hashes for active blocks.
        """
        original = VENDOR + f'{FINGERPRINTS[0]}=\n#{FINGERPRINTS[1]}\n{FINGERPRINTS[2].lower()}\n'.encode()
        self.target.write_bytes(original)
        result = subject.updateBlocklist(self.target, FINGERPRINTS, True)
        content = self.target.read_bytes()
        self.assertEqual(result.added, len(FINGERPRINTS) - 1)
        self.assertTrue(content.startswith(original))
        self.assertTrue(set(FINGERPRINTS).issubset(subject.blockedFingerprints(content)))
        self.assertEqual(content.count(FINGERPRINTS[0].encode()), 1)

    def testLineEndingsAndMissingFinalNewline(self):
        """
        Append complete entries without altering original line endings or joining onto the final line.
        """
        for ending in (b'', b'\r', b'\r\n'):
            original = b'Algorithm=SHA-256\r\n# Vendor comment' + ending
            self.target.write_bytes(original)
            subject.updateBlocklist(self.target, FINGERPRINTS, True)
            content = self.target.read_bytes()
            self.assertTrue(content.startswith(original))
            self.assertTrue(set(FINGERPRINTS).issubset(subject.blockedFingerprints(content)))

    def testInvalidOrMissingBlocklistsAreNotModified(self):
        """
        Reject unsupported algorithms and ambiguous properties before writing, without creating missing files.
        """
        for content in (
            b'',
            b'Algorithm=SHA-512\n',
            b'Algorithm=SHA-256\nAlgorithm SHA-512\n',
            b'Algorithm=SHA-256\nother=continued\\\n',
        ):
            with self.subTest(content=content):
                self.target.write_bytes(content)
                with self.assertRaises(ValueError):
                    subject.updateBlocklist(self.target, FINGERPRINTS, True)

                self.assertEqual(self.target.read_bytes(), content)

        missing = self.root / 'missing'
        with self.assertRaises(FileNotFoundError):
            subject.updateBlocklist(missing, FINGERPRINTS, True)

        self.assertFalse(missing.exists())

    def testPermissionDeniedAppendUsesSudo(self):
        """
        Append to the selected file through sudo without losing vendor data or printing certificate contents.
        """
        def privilegedAppend(**arguments):
            """
            Simulate the external append command rather than mocking the updater's private helpers.
            """
            command = arguments['args']
            mode = 'a' if '-a' in command else 'w'
            with open(file=command[-1], mode=mode, encoding=arguments['encoding']) as output:
                output.write(arguments['input'])

            return subprocess.CompletedProcess(command, 0)

        with mock.patch.object(target=subject.Path, attribute='open', autospec=True, side_effect=self.openReadOnly):
            with mock.patch.object(target=subject.subprocess, attribute='run', side_effect=privilegedAppend) as sudo:
                result = subject.updateBlocklist(self.target, FINGERPRINTS, True)

        self.assertEqual(Path(sudo.call_args.kwargs['args'][0]).name, 'sudo')
        self.assertEqual(sudo.call_args.kwargs['stdout'], subprocess.DEVNULL)
        self.assertEqual(result.added, len(FINGERPRINTS))
        self.assertTrue(self.target.read_bytes().startswith(VENDOR))
        self.assertTrue(set(FINGERPRINTS).issubset(subject.blockedFingerprints(self.target.read_bytes())))

    def testFailedOrIneffectiveSudoDoesNotReportProtection(self):
        """
        Treat both command failure and a successful command that wrote nothing as failed updates.
        """
        for returncode in (0, 1):
            with self.subTest(returncode=returncode):
                response = subprocess.CompletedProcess([], returncode)
                with mock.patch.object(
                    target=subject.Path, attribute='open', autospec=True, side_effect=self.openReadOnly
                ):
                    with mock.patch.object(target=subject.subprocess, attribute='run', return_value=response):
                        with self.assertRaises(ValueError):
                            subject.updateBlocklist(self.target, FINGERPRINTS, True)

                self.assertEqual(self.target.read_bytes(), VENDOR)

    def testPromptPolicyAndDiagnosticStreams(self):
        """
        Explain interactive sudo before invoking it, never prompt in CI/headless runs, and keep stdout clean.
        """
        for terminal, ci, nonInteractive in ((True, '', False), (False, '', True), (True, 'true', True)):
            with self.subTest(terminal=terminal, ci=ci):
                errors, output = io.StringIO(), io.StringIO()

                def authorize(**arguments):
                    """
                    Check the user has context before an external command could request authorization.
                    """
                    self.assertEqual('-n' in arguments['args'], nonInteractive)
                    self.assertEqual(bool(errors.getvalue()), not nonInteractive)
                    return subprocess.CompletedProcess(arguments['args'], 0)

                with contextlib.ExitStack() as stack:
                    stack.enter_context(contextlib.redirect_stderr(errors))
                    stack.enter_context(contextlib.redirect_stdout(output))
                    stack.enter_context(mock.patch.dict(os.environ, {'CI': ci}))
                    stack.enter_context(mock.patch.object(target=sys.stdin, attribute='isatty', return_value=terminal))
                    stack.enter_context(
                        mock.patch.object(target=subject.Path, attribute='open', side_effect=PermissionError)
                    )
                    stack.enter_context(
                        mock.patch.object(target=subject.subprocess, attribute='run', side_effect=authorize)
                    )
                    subject.appendBlocklist(self.target, 'entries\n')

                self.assertEqual(output.getvalue(), '')
                if not nonInteractive:
                    self.assertIn(str(self.target), errors.getvalue())


class DiscoveryTests(FixtureTest):
    """
    Cover discovery inputs, representative installation layouts, and reported search limits.
    """
    def testConfiguredManagerRoots(self):
        """
        Honor configured version-manager and cache locations rather than assuming default home directories.
        """
        environment = {
            'SDKMAN_DIR': '/custom/sdkman',
            'ASDF_DATA_DIR': '/custom/asdf',
            'MISE_DATA_DIR': '/custom/mise',
            'JENV_ROOT': '/custom/jenv',
            'GRADLE_USER_HOME': '/custom/gradle',
            'RUNNER_TOOL_CACHE': '/custom/toolcache',
        }
        roots = {root.path for root in subject.defaultRoots(environment, self.root, 'linux')}
        expected = (
            '/custom/sdkman/candidates/java', '/custom/asdf/installs/java', '/custom/mise/installs/java',
            '/custom/jenv/versions', '/custom/gradle/jdks', '/custom/toolcache',
        )
        self.assertTrue({Path(path) for path in expected} <= roots)

    def testLayoutsAliasesAndCycles(self):
        """
        Find manager, IDE, Gradle, and tool-cache runtimes without duplicate homes or false cycle warnings.
        """
        names = (
            'manager/java/25', 'Android Studio.app/Contents/jbr/Contents/Home',
            'Toolbox.app/Contents/jre/Contents/Home', 'gradle/jdks/vendor-21/Contents/Home',
            'toolcache/Java_Temurin-Hotspot_jdk/25/x64',
        )
        homes = {self.makeJava(name)[0] for name in names}
        (self.root / 'alias').symlink_to(target=self.root / 'manager', target_is_directory=True)
        (self.root / 'cycle').symlink_to(target=self.root, target_is_directory=True)
        discovery = subject.Discovery()
        subject.scanRoot(subject.SearchRoot(self.root), discovery)
        self.assertEqual(discovery.homes, homes)
        self.assertEqual(discovery.errors, [])
        self.assertEqual(discovery.skipped, [])

    def testHomebrewSearchFindsJavaButSkipsUnrelatedPackages(self):
        """
        Use the configured Homebrew root to find nested JDKs without traversing unrelated formulae.
        """
        openjdk, _ = self.makeJava('brew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home')
        temurin, _ = self.makeJava('brew/opt/temurin/current')
        self.makeJava('brew/opt/node/embedded-java')
        roots = subject.defaultRoots({'HOMEBREW_PREFIX': str(self.root / 'brew')}, self.root, 'darwin')
        root = next(root for root in roots if root.path == self.root / 'brew/opt')
        discovery = subject.Discovery()
        subject.scanRoot(root, discovery)
        self.assertEqual(discovery.homes, {openjdk, temurin})
        self.assertEqual(discovery.errors, [])

    def testConfiguredHomesAndAllPathEntriesExcludeShims(self):
        """
        Include every real PATH installation and configured home, but do not treat shims as Java runtimes.
        """
        first, _ = self.makeJava('first')
        second, _ = self.makeJava('second')
        shim = self.root / 'shims'
        shim.mkdir()
        (shim / 'java').write_text('not a JVM')
        environment = {
            'PATH': os.pathsep.join(map(str, (first / 'bin', second / 'bin', shim))),
            'JAVA_HOME': str(first),
        }
        with mock.patch.object(target=subject, attribute='defaultRoots', return_value=[]):
            discovery = subject.discoverInstallations(environment, self.root, 'linux', [])

        self.assertEqual(discovery.homes, {first, second})

    def testInvalidOrInaccessibleSearchRootsAreReported(self):
        """
        Ignore absent optional roots but report required, non-directory, and unreadable roots.
        """
        discovery = subject.Discovery()
        subject.scanRoot(subject.SearchRoot(self.root / 'optional'), discovery)
        self.assertEqual(discovery.errors, [])
        self.assertTrue(discovery.skipped)
        subject.scanRoot(subject.SearchRoot(path=self.root / 'required', required=True), discovery)
        file = self.root / 'file.app'
        file.write_text('fixture')
        subject.scanRoot(subject.SearchRoot(path=file, required=True), discovery)
        with mock.patch.object(
            target=subject.os, attribute='scandir', side_effect=PermissionError(errno.EACCES, 'denied')
        ):
            subject.scanRoot(subject.SearchRoot(self.root), discovery)

        self.assertEqual(len(discovery.errors), 3)

    def testDepthLimitDoesNotClaimDeeperInstallations(self):
        """
        Leave out runtimes beyond the requested traversal limit and report the skipped scope.
        """
        home, _ = self.makeJava('nested/deeper/jdk')
        discovery = subject.Discovery()
        subject.scanRoot(subject.SearchRoot(path=self.root, depth=1), discovery)
        self.assertNotIn(home, discovery.homes)
        self.assertTrue(discovery.skipped)

    def testMacRegistryContributesRuntimeHomes(self):
        """
        Read registered runtime locations from the macOS registry response.
        """
        home, _ = self.makeJava()
        response = subprocess.CompletedProcess([], 0, plistlib.dumps([{'JVMHomePath': str(home)}]), b'')
        with mock.patch.object(target=subject, attribute='defaultRoots', return_value=[]):
            with mock.patch.object(target=subject.Path, attribute='is_file', return_value=True):
                with mock.patch.object(target=subject.subprocess, attribute='run', return_value=response):
                    discovery = subject.discoverInstallations({}, self.root, 'darwin', [])

        self.assertEqual(discovery.homes, {home})
        self.assertEqual(discovery.errors, [])


class CliTests(FixtureTest):
    """
    Exercise selected and discovered installations through the public CLI and reports.
    """
    def testSelectedHomeDefaultsToDryRunAndRequiresApply(self):
        """
        Honor both JAVA_HOME and explicit selection without changing files until apply is requested.
        """
        for selection in ('environment', 'argument'):
            with self.subTest(selection=selection):
                home, target = self.makeJava(f'{selection} jdk with spaces')
                arguments = [] if selection == 'environment' else ['--java-home', str(home)]
                configured = home if selection == 'environment' else self.root / 'unused'
                with mock.patch.dict(os.environ, {'JAVA_HOME': str(configured)}):
                    status, output, _ = self.invoke([*arguments, '--json'])
                    self.assertEqual(status, 0)
                    self.assertEqual(json.loads(output)['mode'], 'dry-run')
                    self.assertEqual(target.read_bytes(), VENDOR)
                    status, output, _ = self.invoke([*arguments, '--apply', '--json'])

                self.assertEqual(status, 0)
                self.assertEqual(json.loads(output)['blocklists'][0]['added'], len(FINGERPRINTS))

    def testAllModePatchesUniqueFilesAndPreservesAliases(self):
        """
        Protect Java 8 and modern layouts while deduplicating runtime aliases and shared symlink targets.
        """
        first, firstTarget = self.makeJava('java8', '1.8')
        _, secondTarget = self.makeJava('modern')
        _, sharedTarget = self.makeJava('shared')
        sharedTarget.unlink()
        sharedTarget.symlink_to(firstTarget)
        self.makeJava(name='same-runtime', specification='1.8', runtimeHome=first / 'jre')
        (self.root / 'alias').symlink_to(target=first, target_is_directory=True)
        status, output, _ = self.invokeAll(self.root, ['--apply', '--json'])
        report = json.loads(output)
        self.assertEqual(status, 0)
        self.assertEqual(len(report['runtimes']), 3)
        self.assertEqual(len(report['blocklists']), 2)
        self.assertEqual(sum(entry['added'] for entry in report['blocklists']), 2 * len(FINGERPRINTS))
        self.assertTrue(sharedTarget.is_symlink())
        for target in (firstTarget, secondTarget):
            self.assertTrue(set(FINGERPRINTS).issubset(subject.blockedFingerprints(target.read_bytes())))

    def testPartialFailuresDoNotHideSuccessOrLeakDiagnostics(self):
        """
        Continue updating valid files but return failure for inspection, blocklist, or search errors.
        """
        for failure in ('inspection', 'blocklist', 'search'):
            with self.subTest(failure=failure):
                _, goodTarget = self.makeJava(f'{failure}/good')
                bad, badTarget = self.makeJava(f'{failure}/bad')
                arguments = ['--apply', '--json']
                if failure == 'inspection':
                    (bad / 'bin/java').write_text("#!/bin/sh\necho 'SECRET_SENTINEL' >&2\nexit 1\n")
                elif failure == 'blocklist':
                    badTarget.write_bytes(b'Algorithm=SHA-512\n')
                else:
                    arguments += ['--search-root', str(self.root / 'missing')]

                before = badTarget.read_bytes()
                status, output, errors = self.invokeAll(self.root / failure, arguments)
                report = json.loads(output)
                self.assertEqual(status, 1)
                self.assertNotIn('SECRET_SENTINEL', output + errors)
                self.assertTrue(any(entry['status'] == 'patched' for entry in report['blocklists']))
                self.assertTrue(set(FINGERPRINTS).issubset(subject.blockedFingerprints(goodTarget.read_bytes())))
                if failure != 'search':
                    self.assertEqual(badTarget.read_bytes(), before)

    def testEmptyDiscoveryIsSuccessfulNoOp(self):
        """
        Allow Java-free machines in dry-run and apply modes without claiming protection or requesting sudo.
        """
        for mode in ('--dry-run', '--apply'):
            for outputMode in ([], ['--json']):
                with self.subTest(mode=mode, outputMode=outputMode):
                    with mock.patch.object(subject, 'appendBlocklist') as append:
                        status, output, errors = self.invokeAll(self.root, [mode, *outputMode])
                    self.assertEqual(status, 0)
                    self.assertEqual(errors, '')
                    append.assert_not_called()
                    if outputMode:
                        report = json.loads(output)
                        self.assertEqual(report['errors'], [])
                        self.assertEqual(report['runtimes'], [])
                        self.assertEqual(report['blocklists'], [])
                    else:
                        self.assertIn('nothing to patch', output)
                        self.assertNotIn('Restart existing', output)

    def testRequireJavaRejectsEmptyDiscovery(self):
        """
        Let provisioning callers explicitly require an installation without changing the report schema.
        """
        for mode in ('--dry-run', '--apply'):
            with self.subTest(mode=mode):
                status, output, _ = self.invokeAll(self.root, ['--require-java', mode, '--json'])
                report = json.loads(output)
                self.assertEqual(status, 1)
                self.assertEqual(report['errors'], ['No Java installations found in the searched locations.'])
                self.assertEqual(report['runtimes'], [])
                self.assertEqual(report['blocklists'], [])

    def testRequireJavaAcceptsInstalledRuntime(self):
        """
        Strict discovery succeeds when an installation can actually be inspected and patched.
        """
        self.makeJava()
        status, output, _ = self.invokeAll(self.root, ['--require-java', '--apply', '--json'])
        report = json.loads(output)
        self.assertEqual(status, 0)
        self.assertEqual(report['errors'], [])
        self.assertEqual(report['blocklists'][0]['status'], 'patched')

    def testEmptyDiscoveryDoesNotHideSearchErrors(self):
        """
        A missing required search directory is still a failure even when no Java was discovered.
        """
        status, output, _ = self.invokeAll(self.root / 'missing', ['--json'])
        report = json.loads(output)
        self.assertEqual(status, 1)
        self.assertTrue(report['errors'])
        self.assertEqual(report['runtimes'], [])

    def testInvalidSelectedJavaStillFails(self):
        """
        Missing explicit or configured JVMs are inspection failures, not clean empty inventories.
        """
        missing = str(self.root / 'missing-jdk')
        for arguments in (['--java-home', missing], []):
            with self.subTest(arguments=arguments):
                with mock.patch.dict(os.environ, {'JAVA_HOME': missing}):
                    status, output, _ = self.invoke([*arguments, '--json'])
                report = json.loads(output)
                self.assertEqual(status, 1)
                self.assertEqual(report['runtimes'][0]['status'], 'failed')
                self.assertEqual(report['blocklists'], [])

    def testReportsKeepJsonAndTextErrorsOnTheirIntendedStreams(self):
        """
        Keep JSON parseable and send text-mode search errors to stderr without pinning report wording.
        """
        missing = self.root / 'missing'
        for outputMode in ([], ['--json']):
            with self.subTest(arguments=outputMode):
                status, output, errors = self.invokeAll(self.root, ['--search-root', str(missing), *outputMode])
                self.assertEqual(status, 1)
                if outputMode:
                    self.assertTrue(json.loads(output)['errors'])
                    self.assertEqual(errors, '')
                else:
                    self.assertIn(str(missing), errors)
                    self.assertNotIn(str(missing), output)


if __name__ == '__main__':
    unittest.main()
