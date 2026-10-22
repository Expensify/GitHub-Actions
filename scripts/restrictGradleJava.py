#!/usr/bin/env python3
"""
Configure Gradle to use the JDK already protected by the certificate-blocklist action.
"""
import json
import os
import sys
from pathlib import Path


def restrictGradle(javaHome: Path, gradleHome: Path) -> None:
    """
    Append overriding Java Properties without rewriting unrelated settings or changing file permissions.

    Two leading newlines terminate any unfinished continuation in the existing file. Java Properties
    uses the last occurrence of a key, including keys previously written with escapes or continuations.
    Repeating the same configuration does not append another block or require write permission.
    """
    path = str(javaHome)
    if ',' in path or any(ord(character) < 32 or ord(character) == 127 for character in path):
        raise ValueError('Gradle JDK paths cannot contain commas or control characters.')

    # JSON's ASCII string escaping also handles backslashes and Unicode in Java Properties values.
    escapedPath = json.dumps(path, ensure_ascii=True)[1:-1]
    settings = (
        '\n\n# Managed by Expensify/GitHub-Actions: restrict-gradle\n'
        f'org.gradle.java.home={escapedPath}\n'
        'org.gradle.java.installations.auto-detect=false\n'
        'org.gradle.java.installations.auto-download=false\n'
        'org.gradle.java.installations.fromEnv=\n'
        f'org.gradle.java.installations.paths={escapedPath}\n'
    ).encode('ascii')
    properties = gradleHome / 'gradle.properties'
    original = properties.read_bytes() if properties.exists() else b''
    if original.endswith(settings):
        print(f'Gradle already restricted to {javaHome}.')
        return

    gradleHome.mkdir(parents=True, exist_ok=True)
    with properties.open('ab') as output:
        output.write(settings)

    print(f'Restricted Gradle to {javaHome} in {properties}.')


def main() -> None:
    """
    Honor the action's selected JDK and Gradle user home, requiring a matching Gradle launcher JVM.
    """
    configuredHome = os.environ.get('JAVA_HOME')
    if not configuredHome:
        raise ValueError('restrict-gradle requires JAVA_HOME; select the protected JDK with actions/setup-java first.')

    launcherHome = Path(configuredHome).expanduser().resolve(strict=True)
    javaHome = Path(os.environ.get('BLOCKLIST_JAVA_HOME') or configuredHome).expanduser().resolve(strict=True)
    if javaHome != launcherHome:
        raise ValueError('restrict-gradle requires JAVA_HOME and java-home to select the same JDK.')

    gradleHome = Path(os.environ.get('GRADLE_USER_HOME') or Path.home() / '.gradle').expanduser().absolute()
    restrictGradle(javaHome, gradleHome)


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError) as error:
        print(f'ERROR: {error}', file=sys.stderr)
        sys.exit(1)
