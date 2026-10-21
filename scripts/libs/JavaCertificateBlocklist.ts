import {appendFileSync, closeSync, constants, existsSync, fstatSync, fsyncSync, openSync, readFileSync, realpathSync, statSync} from 'node:fs';
import path from 'node:path';

type JavaRuntime = {
    home: string;
    vendor: string;
    version: string;
};

/** Validate the checked-in incident snapshot rather than downloading policy during a build. */
function parseFingerprints(manifest: string): string[] {
    const fingerprints = manifest
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'));
    if (fingerprints.length !== 16 || new Set(fingerprints).size !== 16 || fingerprints.some((fingerprint) => !/^[0-9A-F]{64}$/.test(fingerprint))) {
        throw new Error('Expected 16 distinct uppercase SHA-256 certificate fingerprints.');
    }
    return fingerprints;
}

function parseJavaRuntime(properties: string): JavaRuntime {
    function property(name: string): string {
        const prefix = `${name} = `;
        const value = properties
            .split(/\r?\n/)
            .map((line) => line.trimStart())
            .find((line) => line.startsWith(prefix))
            ?.slice(prefix.length);
        if (!value) {
            throw new Error(`The selected JVM did not report ${name}.`);
        }
        return value;
    }

    const home = property('java.home');
    const specification = property('java.specification.version');
    if (!path.isAbsolute(home) || !/^(?:1\.)?\d+$/.test(specification) || Number(specification.replace(/^1\./, '')) < 8) {
        throw new Error('Expected an absolute java.home and Java 8 or newer.');
    }
    return {home, vendor: property('java.vendor'), version: property('java.runtime.version')};
}

function resolveBlocklist(runtimeHome: string): string {
    // Discover both names: vendors and older updates can use different layouts for the same Java major.
    const candidates = ['blocked.certs', 'blacklisted.certs'].map((name) => path.join(runtimeHome, 'lib', 'security', name)).filter((candidate) => existsSync(candidate));
    if (candidates.length !== 1) {
        throw new Error(`Expected exactly one existing JVM certificate blocklist under ${runtimeHome}/lib/security; found ${candidates.length}.`);
    }
    const [candidate] = candidates;
    const target = realpathSync(candidate);
    if (!statSync(target).isFile()) {
        throw new Error(`JVM certificate blocklist is not a regular file: ${target}`);
    }
    return target;
}

/** Parse the literal subset of Java Properties used by vendor blocklists. Never count commented keys. */
function blockedFingerprints(content: Buffer): Set<string> {
    const algorithms: string[] = [];
    const fingerprints = new Set<string>();
    // Properties.load(InputStream) uses ISO-8859-1, not UTF-8. Only CR/LF delimit Java property lines.
    for (const sourceLine of content.toString('latin1').split(/\r\n|\r|\n/)) {
        const line = sourceLine.replace(/^[ \t\f]+/, '');
        if (!line || line.startsWith('#') || line.startsWith('!')) {
            continue;
        }
        // Escapes can disguise Algorithm overrides or consume an appended key through a continuation.
        if (line.includes('\\')) {
            throw new Error('Unsupported blocklist escapes/continuations; nothing changed.');
        }
        const property = /^([^ \t\f=:]+)(.*)$/.exec(line);
        if (!property) {
            throw new Error('Unsupported JVM certificate blocklist property.');
        }
        const [, key, suffix] = property;
        if (key === 'Algorithm') {
            algorithms.push(suffix.replace(/^[ \t\f]*(?:[=:][ \t\f]*)?/, ''));
        } else if (/^[0-9A-F]{64}$/.test(key)) {
            fingerprints.add(key);
        }
    }
    if (algorithms.length !== 1 || algorithms.at(0) !== 'SHA-256') {
        throw new Error('Expected exactly one existing Algorithm=SHA-256 property; nothing changed.');
    }
    return fingerprints;
}

function updateBlocklist(target: string, fingerprints: string[]): number {
    const before = statSync(target);
    if (!before.isFile()) {
        throw new Error(`JVM certificate blocklist is not a regular file: ${target}`);
    }
    const original = readFileSync(target);
    const existing = blockedFingerprints(original);
    const missing = fingerprints.filter((fingerprint) => !existing.has(fingerprint));
    // Already-patched, read-only vendor files need no write permission or sudo.
    if (missing.length === 0) {
        return 0;
    }

    // Append to the physical file instead of replacing it, preserving symlinks and vendor metadata.
    // eslint-disable-next-line no-bitwise -- filesystem open flags are a bitmask
    const descriptor = openSync(target, constants.O_RDWR | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0));
    try {
        const opened = fstatSync(descriptor);
        if (opened.ino !== before.ino || opened.dev !== before.dev) {
            throw new Error('JVM certificate blocklist changed before the update.');
        }
        const separator = original.at(-1) === 10 || original.at(-1) === 13 ? '' : '\n';
        appendFileSync(descriptor, `${separator}${missing.join('\n')}\n`, 'ascii');
        fsyncSync(descriptor);

        const updated = readFileSync(target);
        const after = statSync(target);
        const blocked = blockedFingerprints(updated);
        if (!updated.subarray(0, original.length).equals(original) || fingerprints.some((fingerprint) => !blocked.has(fingerprint))) {
            throw new Error('JVM certificate blocklist verification failed.');
        }
        if (before.mode !== after.mode || before.uid !== after.uid || before.gid !== after.gid || before.ino !== after.ino || before.dev !== after.dev) {
            throw new Error('JVM certificate blocklist metadata changed.');
        }
        return missing.length;
    } finally {
        closeSync(descriptor);
    }
}

export {blockedFingerprints, parseFingerprints, parseJavaRuntime, resolveBlocklist, updateBlocklist};
