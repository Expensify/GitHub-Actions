#!/usr/bin/env python3
"""
Discover and protect local Java runtimes. Requires Python 3.9+, with no external packages.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import plistlib
import re
import stat
import subprocess
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Literal

SCRIPT = Path(__file__).resolve()
# The certificate source is https://emudhra.we-have-a-problem.com/impacted-intermediates.json (reviewed snapshot).
CERTIFICATES = SCRIPT.parent.parent / 'block-compromised-java-certificates/compromised-java-certificates.pem'
BLOCKLIST_NAMES = ('blocked.certs', 'blacklisted.certs')


@dataclass(frozen=True)
class SearchRoot:
    """
    Describe a discovery root, its traversal limit, and whether a missing directory is an error.
    """
    path: Path
    depth: int = 6
    required: bool = False
    kind: str = 'runtime'


@dataclass
class Discovery:
    """
    Collect candidate runtime homes and the coverage, skips, and errors from discovery.
    """
    homes: set[Path] = field(default_factory=set)
    searched: list[str] = field(default_factory=list)
    skipped: list[dict] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class BlocklistUpdate:
    """
    Describe the outcome of inspecting or updating one blocklist file.
    """
    status: Literal['would-patch', 'already-protected', 'patched']
    missing: int
    added: int = 0


@dataclass(frozen=True)
class JavaRuntime:
    """
    Hold the actual runtime home, vendor, and version reported by a Java executable.
    """
    home: Path
    vendor: str
    version: str


def certificateFingerprints(bundle: str) -> list[str]:
    """
    Derive uppercase SHA-256 certificate fingerprints from the reviewed PEM bundle.

    Trust the checked-in policy's format and allow its size to change. Hash each certificate's
    DER bytes, not its public key; reject an empty policy rather than report protection from it.
    """
    certificates = re.findall(r'-----BEGIN CERTIFICATE-----(.*?)-----END CERTIFICATE-----', bundle, re.DOTALL)
    if not certificates:
        raise ValueError('No certificates found in the bundled policy.')

    return [hashlib.sha256(base64.b64decode(certificate)).hexdigest().upper() for certificate in certificates]


def blockedFingerprints(content: bytes) -> set[str]:
    """
    Return active fingerprint keys from a SHA-256 Java Properties blocklist.

    Reject duplicate algorithm declarations, escapes, and continuations rather than risk
    interpreting a property differently from the JVM. Ignore commented and non-fingerprint keys.
    """
    algorithms = []
    fingerprints = set()
    # Java Properties.load(InputStream) uses Latin-1 and CR/LF, not Unicode line boundaries.
    for sourceLine in re.split(r'\r\n|\r|\n', content.decode('latin1')):
        line = sourceLine.lstrip(' \t\f')
        if not line or line.startswith(('#', '!')):
            continue

        if '\\' in line:
            raise ValueError('Unsupported blocklist escapes/continuations; nothing changed.')

        match = re.fullmatch(r'([^ \t\f=:]+)(.*)', line)
        if not match:
            raise ValueError('Unsupported JVM certificate blocklist property.')

        key, suffix = match.groups()
        if key == 'Algorithm':
            algorithms.append(re.sub(r'^[ \t\f]*(?:[=:][ \t\f]*)?', '', suffix))
        elif re.fullmatch(r'[0-9A-F]{64}', key):
            fingerprints.add(key)

    if algorithms != ['SHA-256']:
        raise ValueError('Expected exactly one existing Algorithm=SHA-256 property; nothing changed.')

    return fingerprints


def appendBlocklist(target: Path, additions: str) -> None:
    """
    Append normally, using sudo only if the write is denied.

    Explain privileged writes before allowing a password prompt in an interactive terminal.
    Never prompt in CI or without a terminal, and keep diagnostics out of JSON stdout.
    """
    try:
        with target.open(mode='a', encoding='ascii') as output:
            output.write(additions)
    except PermissionError:
        command = ['sudo']
        if not sys.stdin.isatty() or os.environ.get('CI'):
            command.append('-n')
        else:
            print(
                f'Updating {target} requires elevated write permission. '
                'sudo may prompt for your password to append the missing certificate fingerprints.',
                file=sys.stderr,
            )

        command += ['tee', '-a', str(target)]
        result = subprocess.run(args=command, input=additions, encoding='ascii', stdout=subprocess.DEVNULL, timeout=120)
        if result.returncode:
            raise ValueError(f'Unable to append to {target} using sudo.')


def updateBlocklist(target: Path, fingerprints: list[str], apply: bool = False) -> BlocklistUpdate:
    """
    Inspect or patch an existing, resolved blocklist and return its status and entry counts.

    Dry-run only reports missing fingerprints. Apply mode appends missing entries to the
    existing file, then reads it back to verify coverage.
    Only the append can request sudo; reading and final verification stay unprivileged.
    """
    if not stat.S_ISREG(target.stat().st_mode):
        raise ValueError(f'JVM certificate blocklist is not a regular file: {target}')

    original = target.read_bytes()
    existing = blockedFingerprints(original)
    missing = [fingerprint for fingerprint in fingerprints if fingerprint not in existing]
    if not missing or not apply:
        return BlocklistUpdate(status='would-patch' if missing else 'already-protected', missing=len(missing))

    separator = '' if original.endswith((b'\n', b'\r')) else '\n'
    entries = '\n'.join(missing)
    appendBlocklist(target, f'{separator}{entries}\n')

    if not set(fingerprints).issubset(blockedFingerprints(target.read_bytes())):
        raise ValueError('JVM certificate blocklist verification failed.')

    return BlocklistUpdate(status='patched', missing=len(missing), added=len(missing))


def inspectRuntime(home: Path) -> JavaRuntime:
    """
    Inspect a selected Java executable and return its actual home, vendor, and version.

    Require Java 8+ and an absolute runtime home. Capture JVM diagnostics without exposing
    potentially secret-bearing JAVA_TOOL_OPTIONS in reports or inspection errors.
    """
    java = home / 'bin/java'
    inspection = subprocess.run(
        args=[str(java), '-XshowSettings:properties', '-version'],
        capture_output=True,
        timeout=20,
    )
    if inspection.returncode:
        # JAVA_TOOL_OPTIONS diagnostics can contain secrets. Never forward raw JVM output, even on failure.
        raise ValueError(f'Cannot inspect the selected JVM: {home}')

    required = ('java.home', 'java.specification.version', 'java.vendor', 'java.runtime.version')
    properties = {}
    for line in (inspection.stdout + b'\n' + inspection.stderr).decode(encoding='utf-8', errors='replace').splitlines():
        key, separator, value = line.lstrip().partition(' = ')
        if separator and key in required and value:
            properties[key] = value

    if any(name not in properties for name in required):
        raise ValueError(f'The selected JVM did not report all required properties: {home}')

    runtimeHome = Path(properties['java.home'])
    majorVersion = properties['java.specification.version'].removeprefix('1.')
    if not runtimeHome.is_absolute() or not majorVersion.isdecimal():
        raise ValueError(f'Unsupported JVM properties: {home}')

    if int(majorVersion) < 8:
        raise ValueError(f'Java 8 or newer is required: {home}')

    return JavaRuntime(
        home=runtimeHome.resolve(strict=True),
        vendor=properties['java.vendor'],
        version=properties['java.runtime.version'],
    )


def resolveBlocklist(home: Path) -> Path:
    """
    Resolve the runtime's single existing blocklist to a physical regular file.

    Accept either vendor filename, but reject missing or ambiguous layouts instead of creating
    a file the JVM might not consult.
    """
    candidates = []
    for name in BLOCKLIST_NAMES:
        candidate = home / 'lib/security' / name
        try:
            candidate.stat()
            candidates.append(candidate)
        except FileNotFoundError:
            continue

    if len(candidates) != 1:
        raise ValueError(f'Expected exactly one existing JVM blocklist under {home}/lib/security.')

    target = candidates[0].resolve(strict=True)
    if not target.is_file():
        raise ValueError(f'JVM certificate blocklist is not a regular file: {target}')

    return target


def defaultRoots(environment: dict, home: Path, platform: str) -> list[SearchRoot]:
    """
    Build platform-specific JDK, IDE, version-manager, Gradle, and CI-cache search roots.

    Honor the user's configured installation directories without traversing the whole filesystem.
    """
    dataHome = Path(environment.get('XDG_DATA_HOME', str(home / '.local/share')))
    roots = [
        SearchRoot(Path(environment.get('SDKMAN_DIR', str(home / '.sdkman'))) / 'candidates/java'),
        SearchRoot(Path(environment.get('ASDF_DATA_DIR', str(home / '.asdf'))) / 'installs/java'),
        SearchRoot(Path(environment.get('MISE_DATA_DIR', str(dataHome / 'mise'))) / 'installs/java'),
        SearchRoot(Path(environment.get('JENV_ROOT', str(home / '.jenv'))) / 'versions'),
        SearchRoot(Path(environment.get('GRADLE_USER_HOME', str(home / '.gradle'))) / 'jdks'),
    ]
    if platform == 'darwin':
        roots += [
            SearchRoot(Path('/Library/Java/JavaVirtualMachines')),
            SearchRoot(home / 'Library/Java/JavaVirtualMachines'),
            SearchRoot(Path('/Applications')),
            SearchRoot(home / 'Applications'),
            SearchRoot(path=home / 'Library/Application Support/JetBrains/Toolbox/apps', depth=8),
        ]

        for prefix in sorted({'/opt/homebrew', '/usr/local', environment.get('HOMEBREW_PREFIX', '/opt/homebrew')}):
            roots.append(SearchRoot(path=Path(prefix) / 'opt', kind='homebrew'))
    else:
        roots += [
            SearchRoot(Path(name))
            for name in (
                '/usr/lib/jvm',
                '/usr/local/lib/jvm',
                '/usr/java',
                '/opt/java',
                '/opt/jdk',
                '/opt/jdks',
                '/opt/android-studio',
                '/snap/android-studio/current',
            )
        ]
        roots.append(SearchRoot(dataHome / 'JetBrains/Toolbox/apps', 8))

    if environment.get('RUNNER_TOOL_CACHE'):
        roots.append(SearchRoot(Path(environment['RUNNER_TOOL_CACHE']), 7))

    return roots


def scanRoot(root: SearchRoot, discovery: Discovery) -> None:
    """
    Add one bounded directory scan's runtime homes and coverage details to discovery.

    Follow directory aliases without revisiting inode cycles, recognize embedded app runtimes,
    and record access failures or traversal limits instead of implying complete coverage.
    """
    visited = set()

    def visit(directory: Path, depth: int) -> None:
        """
        Visit a directory once within this root's depth and application-layout constraints.
        """
        try:
            metadata = directory.stat()
            identity = (metadata.st_dev, metadata.st_ino)
            if identity in visited or not stat.S_ISDIR(metadata.st_mode):
                return

            visited.add(identity)
            if (directory / 'bin/java').is_file():
                discovery.homes.add(directory.resolve(strict=True))
                return

            if directory.suffix == '.app':
                for layout in (
                    'Contents/jbr/Contents/Home',
                    'Contents/jbr',
                    'Contents/jre/Contents/Home',
                    'Contents/jre/jdk/Contents/Home',
                    'Contents/Home',
                ):
                    candidate = directory / layout
                    if (candidate / 'bin/java').is_file():
                        discovery.homes.add(candidate.resolve(strict=True))

                return  # Do not traverse unrelated application resources.

            with os.scandir(directory) as entries:
                children = sorted(entry.name for entry in entries if entry.is_dir(follow_symlinks=True))
            if depth >= root.depth:
                if children:
                    discovery.skipped.append({'path': str(directory), 'reason': 'search depth limit'})

                return

            for name in children:
                if name in ('.git', 'node_modules'):
                    continue

                if depth == 0 and root.kind == 'homebrew' and not name.startswith(('openjdk', 'temurin', 'zulu')):
                    continue

                visit(directory / name, depth + 1)
        except OSError as error:
            discovery.errors.append(f'Cannot inspect {directory}: {error.strerror}')

    try:
        if not stat.S_ISDIR(root.path.stat().st_mode):
            discovery.errors.append(f'Search root is not a directory: {root.path}')
            return
    except FileNotFoundError:
        if root.required:
            discovery.errors.append(f'Search root does not exist: {root.path}')
        else:
            discovery.skipped.append({'path': str(root.path), 'reason': 'not present'})

        return
    except OSError as error:
        discovery.errors.append(f'Cannot access search root {root.path}: {error.strerror}')
        return

    discovery.searched.append(str(root.path))
    visit(root.path, 0)


def discoverInstallations(environment: dict, home: Path, platform: str, extraRoots: list[Path]) -> Discovery:
    """
    Discover candidates from configured homes, PATH, platform registries, and search roots.

    Skip PATH stubs and shims without executing them. Treat caller-supplied extra roots as
    required and preserve discovery errors for the final report and exit status.
    """
    discovery = Discovery()
    for variable in ('JAVA_HOME', 'JDK_HOME'):
        if environment.get(variable):
            discovery.homes.add(Path(environment[variable]).expanduser().absolute())

    for directory in environment.get('PATH', '').split(os.pathsep):
        if not directory:
            continue

        executable = Path(directory) / 'java'
        try:
            if executable.is_file():
                resolved = executable.resolve(strict=True)
                candidate = resolved.parent.parent
                # Do not run macOS's java stub or version-manager shims while inventorying PATH.
                if (candidate / 'release').is_file() or (candidate.parent / 'release').is_file():
                    discovery.homes.add(candidate)
                else:
                    discovery.skipped.append({'path': str(executable), 'reason': 'stub, shim, or unknown layout'})
        except OSError as error:
            discovery.errors.append(f'Cannot inspect PATH Java {executable}: {error.strerror}')

    if platform == 'darwin' and Path('/usr/libexec/java_home').is_file():
        try:
            registry = subprocess.run(args=['/usr/libexec/java_home', '-X'], capture_output=True, timeout=20)
            if registry.returncode == 0:
                installations = plistlib.loads(registry.stdout)
                for installation in installations:
                    discovery.homes.add(Path(installation['JVMHomePath']))
            else:
                discovery.skipped.append({'path': 'macOS Java registry', 'reason': 'no registered runtimes'})
        except (OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired) as error:
            discovery.errors.append(f'Cannot read macOS Java registry: {type(error).__name__}')

    roots = defaultRoots(environment, home, platform)
    roots += [SearchRoot(path=path.expanduser().absolute(), required=True) for path in extraRoots]

    for root in roots:
        scanRoot(root, discovery)

    return discovery


def run(homes: list[Path], fingerprints: list[str], apply: bool) -> tuple[list[dict], list[dict]]:
    """
    Collect unique blocklist paths, then update each file and return runtime and file results.

    Resolve runtime and file aliases before writing. Retain individual inspection and update
    failures so other discovered files can still be processed without reporting partial success.
    """
    runtimes = []
    runtimeHomes = set()
    blocklists = set()
    for home in sorted(set(homes)):
        entry = {'path': str(home), 'status': 'discovered'}
        try:
            runtime = inspectRuntime(home)
            if runtime.home in runtimeHomes:
                continue

            runtimeHomes.add(runtime.home)
            target = resolveBlocklist(runtime.home)
            entry.update(
                {
                    'runtime_home': str(runtime.home),
                    'vendor': runtime.vendor,
                    'version': runtime.version,
                    'blocklist': str(target),
                }
            )
            blocklists.add(target)
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            # TimeoutExpired contains the command but no captured JVM diagnostics in str(error).
            entry.update({'status': 'failed', 'error': str(error)})

        runtimes.append(entry)

    results = []
    for target in sorted(blocklists):
        entry = {'path': str(target)}
        try:
            entry.update(asdict(updateBlocklist(target, fingerprints, apply)))
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            entry.update({'status': 'failed', 'error': str(error)})

        results.append(entry)

    return runtimes, results


def main(argv=None) -> int:
    """
    Run the selected CLI mode and return a nonzero status for any discovery or runtime failure.

    Default to a dry-run of JAVA_HOME unless a home or system discovery is explicitly selected.
    Keep discovery unprivileged; only individual append operations can request sudo.
    """
    parser = argparse.ArgumentParser(description=__doc__)
    selection = parser.add_mutually_exclusive_group()
    selection.add_argument('--all', action='store_true', help='Discover installed JVMs in known locations')
    selection.add_argument('--java-home', type=Path, help='Protect only this JDK/JRE (default: JAVA_HOME)')
    parser.add_argument('--search-root', type=Path, action='append', default=[], help='Additional --all search root')
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--apply', action='store_true', help='Apply missing blocks (default: dry-run)')
    mode.add_argument('--dry-run', action='store_true', help='Report changes without writing or requesting sudo')
    parser.add_argument('--json', action='store_true', help='Print the inventory and results as JSON')
    args = parser.parse_args(argv)
    if sys.version_info < (3, 9) or sys.platform not in ('darwin', 'linux'):
        parser.error('Python 3.9+ on Linux or macOS is required.')

    fingerprints = certificateFingerprints(CERTIFICATES.read_text(encoding='ascii'))

    if os.geteuid() == 0:
        parser.error('Run as your normal user, not with sudo; only individual file updates will be elevated.')

    if args.search_root and not args.all:
        parser.error('--search-root requires --all.')

    if args.all:
        discovery = discoverInstallations(dict(os.environ), Path.home(), sys.platform, args.search_root)
    else:
        selected = args.java_home or os.environ.get('JAVA_HOME')
        if not selected:
            parser.error('Set JAVA_HOME, pass --java-home, or use --all.')

        discovery = Discovery(homes={Path(selected).expanduser().absolute()})

    runtimes, blocklists = run(list(discovery.homes), fingerprints, args.apply)
    if not runtimes:
        discovery.errors.append('No Java installations found in the searched locations.')

    report = {
        'mode': 'apply' if args.apply else 'dry-run',
        'searched_roots': discovery.searched,
        'skipped': discovery.skipped,
        'errors': discovery.errors,
        'runtimes': runtimes,
        'blocklists': blocklists,
    }
    if args.json:
        print(json.dumps(obj=report, indent=2))
    else:
        print(f'Java blocklist {report["mode"]} (discovery is limited to the reported search locations).')
        for root in discovery.searched:
            print(f'Searched: {root}')

        for runtime in runtimes:
            if runtime['status'] == 'failed':
                print(f'failed: {runtime["path"]} — {runtime["error"]}')

        for entry in blocklists:
            detail = f' — {entry["error"]}' if 'error' in entry else ''
            print(f'{entry["status"]}: {entry["path"]}{detail}; added {entry.get("added", 0)} fingerprints')
            if entry['status'] == 'would-patch':
                print(f'  Missing {entry["missing"]} fingerprints; rerun with --apply to patch.')

        for error in discovery.errors:
            print(f'ERROR: {error}', file=sys.stderr)

        print(
            f'{len(runtimes)} runtimes; {len(blocklists)} unique blocklists; '
            f'{len(discovery.skipped)} skipped locations.'
        )
        if args.apply:
            print('Restart existing JVMs/Gradle daemons. Rerun after JDK installations or updates.')

    return int(bool(discovery.errors or any(entry['status'] == 'failed' for entry in runtimes + blocklists)))


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print(f'ERROR: {error}', file=sys.stderr)
        sys.exit(1)
