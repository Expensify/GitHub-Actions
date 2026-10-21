import {X509Certificate} from 'node:crypto';
import {constants} from 'node:fs';
import {access, realpath, stat} from 'node:fs/promises';
import path from 'node:path';

import {$} from 'bun';

type JavaRuntime = {
    home: string;
    vendor: string;
    version: string;
};

/** Derive certificate fingerprints from the single checked-in incident snapshot. */
function certificateFingerprints(bundle: string): string[] {
    const certificatePattern = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;
    const certificates = bundle.match(certificatePattern) ?? [];
    if (certificates.length !== 16 || bundle.replaceAll(certificatePattern, '').trim()) {
        throw new Error('Expected 16 distinct PEM certificates.');
    }
    const fingerprints = certificates.map((pem) => new X509Certificate(pem).fingerprint256.replaceAll(':', ''));
    if (new Set(fingerprints).size !== 16) {
        throw new Error('Expected 16 distinct PEM certificates.');
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

async function resolveBlocklist(runtimeHome: string): Promise<string> {
    // Discover both names: vendors and older updates can use different layouts for the same Java major.
    const paths = ['blocked.certs', 'blacklisted.certs'].map((name) => path.join(runtimeHome, 'lib', 'security', name));
    const existing = await Promise.all(paths.map(async (candidate) => ((await Bun.file(candidate).exists()) ? candidate : undefined)));
    const candidates = existing.filter((candidate) => candidate !== undefined);
    if (candidates.length !== 1) {
        throw new Error(`Expected exactly one existing JVM certificate blocklist under ${runtimeHome}/lib/security; found ${candidates.length}.`);
    }
    const [candidate] = candidates;
    const target = await realpath(candidate);
    if (!(await stat(target)).isFile()) {
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

async function updateBlocklist(target: string, fingerprints: string[]): Promise<number> {
    const before = await stat(target);
    if (!before.isFile()) {
        throw new Error(`JVM certificate blocklist is not a regular file: ${target}`);
    }
    const original = Buffer.from(await Bun.file(target).bytes());
    const existing = blockedFingerprints(original);
    const missing = fingerprints.filter((fingerprint) => !existing.has(fingerprint));
    // Already-patched, read-only vendor files need no write permission or sudo.
    if (missing.length === 0) {
        return 0;
    }

    // Check permission separately so the caller can elevate only the file update when necessary.
    await access(target, constants.W_OK);
    const separator = original.at(-1) === 10 || original.at(-1) === 13 ? '' : '\n';
    const additions = `${separator}${missing.join('\n')}\n`;
    // Append instead of replacing the file, preserving existing contents and metadata.
    await $`echo -n ${additions} >> ${target}`.quiet();

    const updated = Buffer.from(await Bun.file(target).bytes());
    const after = await stat(target);
    const blocked = blockedFingerprints(updated);
    if (!updated.subarray(0, original.length).equals(original) || fingerprints.some((fingerprint) => !blocked.has(fingerprint))) {
        throw new Error('JVM certificate blocklist verification failed.');
    }
    if (before.mode !== after.mode || before.uid !== after.uid || before.gid !== after.gid || before.ino !== after.ino || before.dev !== after.dev) {
        throw new Error('JVM certificate blocklist metadata changed.');
    }
    return missing.length;
}

export {blockedFingerprints, certificateFingerprints, parseJavaRuntime, resolveBlocklist, updateBlocklist};
