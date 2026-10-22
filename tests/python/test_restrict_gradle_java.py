"""
Test Gradle configuration using temporary files without launching Java or touching user settings.
"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import restrictGradleJava as subject


class GradleRestrictionTests(unittest.TestCase):
    """
    Cover configuration preservation, runtime selection, custom homes, and failure behavior.
    """
    def setUp(self):
        """
        Isolate every environment and filesystem path from installed JVMs and real Gradle settings.
        """
        temporary = tempfile.TemporaryDirectory(prefix='gradle-blocklist-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.javaHome = self.root / 'JDK with spaces and é'
        self.javaHome.mkdir()
        environment = mock.patch.dict(os.environ, {'HOME': str(self.root), 'JAVA_HOME': str(self.javaHome)}, clear=True)
        environment.start()
        self.addCleanup(environment.stop)

    def testPreservesExistingBytesPermissionsAndRepeatRuns(self):
        """
        Retain comments, credentials, conflicting keys, and unfinished continuations; repeats do not write.
        """
        home = self.root / '.gradle'
        home.mkdir()
        properties = home / 'gradle.properties'
        original = (
            b'# Keep this file\r\ncustom.property=keep-me\r\n'
            b'org.gradle.java.home=/unprotected\r\n'
            b'org.gradle.java.installations.auto-\\u0064etect=true\r\n'
            b'org.gradle.java.installations.fromEnv=OTHER_JAVA_HOME\r\n'
            b'unfinished=continuation\\'
        )
        properties.write_bytes(original)
        properties.chmod(0o600)
        subject.main()
        configured = properties.read_bytes()
        self.assertTrue(configured.startswith(original + b'\n\n'))
        self.assertIn(b'org.gradle.java.installations.auto-detect=false\n', configured)
        self.assertIn(b'org.gradle.java.installations.auto-download=false\n', configured)
        self.assertIn(b'org.gradle.java.installations.fromEnv=\n', configured)
        escaped = json.dumps(str(self.javaHome), ensure_ascii=True)[1:-1].encode('ascii')
        self.assertIn(b'org.gradle.java.home=' + escaped + b'\n', configured)
        self.assertIn(b'org.gradle.java.installations.paths=' + escaped + b'\n', configured)
        self.assertEqual(properties.stat().st_mode & 0o777, 0o600)

        properties.chmod(0o400)
        before = properties.stat()
        subject.main()
        self.assertEqual(properties.read_bytes(), configured)
        self.assertEqual(properties.stat().st_mtime_ns, before.st_mtime_ns)

    def testCustomGradleHomeAndEquivalentExplicitJavaHome(self):
        """
        Resolve an explicit JDK alias and honor a custom Gradle home without changing the default home.
        """
        alias = self.root / 'jdk-alias'
        alias.symlink_to(self.javaHome, target_is_directory=True)
        custom = self.root / 'custom Gradle home'
        with mock.patch.dict(os.environ, {'BLOCKLIST_JAVA_HOME': str(alias), 'GRADLE_USER_HOME': str(custom)}):
            subject.main()

        self.assertTrue((custom / 'gradle.properties').is_file())
        self.assertFalse((self.root / '.gradle').exists())
        self.assertNotIn(str(alias).encode(), (custom / 'gradle.properties').read_bytes())

    def testMismatchedOrMissingLauncherFailsBeforeConfiguration(self):
        """
        Do not claim Gradle is restricted when its launcher would use an unprotected JVM.
        """
        other = self.root / 'other-jdk'
        other.mkdir()
        with mock.patch.dict(os.environ, {'BLOCKLIST_JAVA_HOME': str(other)}):
            with self.assertRaisesRegex(ValueError, 'same JDK'):
                subject.main()

        with mock.patch.dict(os.environ, {'JAVA_HOME': ''}):
            with self.assertRaisesRegex(ValueError, 'requires JAVA_HOME'):
                subject.main()

        self.assertFalse((self.root / '.gradle').exists())

    def testUnsupportedListPathsFailBeforeConfiguration(self):
        """
        Reject path characters that would turn the protected JDK into multiple Gradle toolchain locations.
        """
        for name in ('jdk,other', 'jdk\nother'):
            with self.subTest(name=name):
                home = self.root / name
                home.mkdir()
                with mock.patch.dict(os.environ, {'JAVA_HOME': str(home)}):
                    with self.assertRaisesRegex(ValueError, 'commas or control'):
                        subject.main()

        self.assertFalse((self.root / '.gradle').exists())

    def testWriteFailuresPropagate(self):
        """
        A denied configuration write must fail rather than silently leave unrestricted Gradle settings.
        """
        with mock.patch.object(Path, 'open', side_effect=PermissionError('fixture denied')):
            with self.assertRaises(PermissionError):
                subject.main()


if __name__ == '__main__':
    unittest.main()
