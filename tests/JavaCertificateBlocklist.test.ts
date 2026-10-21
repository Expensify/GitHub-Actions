import assert from 'node:assert/strict';
import {X509Certificate} from 'node:crypto';
import {chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, it} from 'node:test';

import {blockedFingerprints, parseFingerprints, parseJavaRuntime, resolveBlocklist, updateBlocklist} from '../scripts/libs/JavaCertificateBlocklist';

const MANIFEST = readFileSync(new URL('../block-compromised-java-certificates/compromised-java-certificates.txt', import.meta.url), 'utf8');
const FINGERPRINTS = parseFingerprints(MANIFEST);
const [FIRST_FINGERPRINT, SECOND_FINGERPRINT, THIRD_FINGERPRINT, FOURTH_FINGERPRINT] = FINGERPRINTS;
const VENDOR_CONTENT = Buffer.from(`Algorithm=SHA-256\n# Vendor entry; keep comments and ordering\n${'F'.repeat(64)}\n`);

describe('Java certificate blocklist manifest', () => {
    it('contains all 16 distinct certificate fingerprints, not SPKI hashes', () => {
        assert.equal(FINGERPRINTS.length, 16);
        assert.equal(new Set(FINGERPRINTS).size, 16);
        assert.deepEqual(parseFingerprints(` # A comment\r\n${FINGERPRINTS.join('\r\n')}\r\n`), FINGERPRINTS);
        const bundle = readFileSync(new URL('./fixtures/java-blocklist/impacted-certificates.pem', import.meta.url), 'ascii');
        const certificates = bundle.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
        const actual = certificates.map((pem) => new X509Certificate(pem).fingerprint256.replaceAll(':', ''));
        assert.equal(certificates.length, 16);
        assert.deepEqual(actual.sort(), [...FINGERPRINTS].sort());
    });

    it('rejects missing, duplicate, lowercase, or malformed fingerprints', () => {
        for (const entries of [
            FINGERPRINTS.slice(1),
            [...FINGERPRINTS, FIRST_FINGERPRINT],
            [...FINGERPRINTS.slice(1), SECOND_FINGERPRINT],
            FINGERPRINTS.map((value) => value.toLowerCase()),
            ['bad'],
        ]) {
            assert.throws(() => parseFingerprints(entries.join('\n')), /16 distinct uppercase SHA-256/);
        }
    });
});

describe('JVM discovery', () => {
    it('reads the actual java.home rather than assuming JAVA_HOME is the runtime directory', () => {
        for (const specification of ['1.8', '11', '17', '21', '25', '27']) {
            const properties = `Picked up JAVA_TOOL_OPTIONS: secret\r\n    java.home = /jdk with spaces/jre\r\n    java.specification.version = ${specification}\r\n    java.vendor = Example vendor\r\n    java.runtime.version = Example runtime\r\n`;
            assert.deepEqual(parseJavaRuntime(properties), {home: '/jdk with spaces/jre', vendor: 'Example vendor', version: 'Example runtime'});
        }
    });

    it('fails on missing properties, relative homes, and unsupported versions', () => {
        for (const [home, specification] of [
            ['/jdk', '1.7'],
            ['/jdk', 'unknown'],
            ['/jdk', '0'],
            ['relative', '25'],
        ]) {
            assert.throws(() => parseJavaRuntime(`java.home = ${home}\njava.specification.version = ${specification}\n`), /absolute java.home and Java 8/);
        }
        assert.throws(() => parseJavaRuntime(''), /did not report java.home/);
    });
});

describe('Java Properties parsing', () => {
    it('accepts literal key separators and Java whitespace, including CRLF and bare keys', () => {
        for (const algorithm of ['Algorithm=SHA-256', 'Algorithm : SHA-256', '\tAlgorithm\fSHA-256']) {
            for (const separator of ['', '=', ':ignored', ' ignored', '\tignored']) {
                assert.deepEqual(blockedFingerprints(Buffer.from(`${algorithm}\r\n  ${FIRST_FINGERPRINT}${separator}\r\n`)), new Set([FIRST_FINGERPRINT]));
            }
        }
    });

    it('does not count commented, lowercase, or partial fingerprints', () => {
        const content = `Algorithm=SHA-256\n# ${FIRST_FINGERPRINT}\n !${SECOND_FINGERPRINT}\n${THIRD_FINGERPRINT.toLowerCase()}\n${FOURTH_FINGERPRINT.slice(1)}\n`;
        assert.deepEqual(blockedFingerprints(Buffer.from(content)), new Set());
    });

    it('does not treat non-Java Unicode line separators as new properties', () => {
        const content = `Algorithm=SHA-256\n# Not a new line\u0085${FIRST_FINGERPRINT}\n`;
        assert.deepEqual(blockedFingerprints(Buffer.from(content, 'latin1')), new Set());
    });

    it('rejects missing, duplicate, escaped, continued, or unexpected algorithm properties', () => {
        for (const content of [
            '',
            'Algorithm=SHA-512\n',
            'Algorithm==SHA-256\n',
            'Algorithm=SHA-256 \n',
            'Algorithm=SHA-256\nAlgorithm=SHA-256\n',
            'Algorithm=SHA-256\nAlgorithm SHA-512\n',
            'Algorithm=SHA-256\nAlgorithm\n',
            '\uFEFFAlgorithm=SHA-256\n',
            'Algorithm=SHA-256\nAlgorith\\u006d=SHA-512\n',
            'Algorithm=SHA-256\nother=continued\\\n',
        ]) {
            assert.throws(() => blockedFingerprints(Buffer.from(content)), /Algorithm|escapes/);
        }
    });
});

describe('JVM certificate blocklist update', () => {
    let directory: string;
    let target: string;

    beforeEach(() => {
        directory = mkdtempSync(path.join(tmpdir(), 'java-blocklist-'));
        target = path.join(directory, 'vendor.certs');
        writeFileSync(target, VENDOR_CONTENT);
        chmodSync(target, 0o640);
    });

    afterEach(() => {
        rmSync(directory, {recursive: true, force: true});
    });

    it('appends all missing fingerprints while preserving vendor content and metadata', () => {
        const before = statSync(target);
        assert.equal(updateBlocklist(target, FINGERPRINTS), 16);
        const content = readFileSync(target);
        assert.ok(content.subarray(0, VENDOR_CONTENT.length).equals(VENDOR_CONTENT));
        for (const fingerprint of FINGERPRINTS) {
            assert.ok(blockedFingerprints(content).has(fingerprint));
        }
        const after = statSync(target);
        for (const field of ['mode', 'uid', 'gid', 'ino', 'dev'] as const) {
            assert.equal(after[field], before[field]);
        }
    });

    it('is byte-for-byte idempotent and does not change mtime on a repeat run', () => {
        updateBlocklist(target, FINGERPRINTS);
        const content = readFileSync(target);
        const modified = statSync(target).mtimeMs;
        assert.equal(updateBlocklist(target, FINGERPRINTS), 0);
        assert.deepEqual(readFileSync(target), content);
        assert.equal(statSync(target).mtimeMs, modified);
    });

    it('adds only genuinely missing keys, not duplicate bare or key-value entries', () => {
        writeFileSync(target, Buffer.concat([VENDOR_CONTENT, Buffer.from(`${FIRST_FINGERPRINT}=\n#${SECOND_FINGERPRINT}\n${THIRD_FINGERPRINT.toLowerCase()}\n`)]));
        assert.equal(updateBlocklist(target, FINGERPRINTS), 15);
        assert.equal(
            readFileSync(target, 'utf8')
                .split('\n')
                .filter((line) => line === FIRST_FINGERPRINT).length,
            0,
        );
    });

    it('verifies an already-patched read-only file without needing write permission', () => {
        updateBlocklist(target, FINGERPRINTS);
        chmodSync(target, 0o400);
        const content = readFileSync(target);
        const before = statSync(target);
        assert.equal(updateBlocklist(target, FINGERPRINTS), 0);
        assert.deepEqual(readFileSync(target), content);
        assert.equal(statSync(target).mode, before.mode);
        assert.equal(statSync(target).mtimeMs, before.mtimeMs);
    });

    it('handles CRLF and missing final newlines without altering original bytes', () => {
        for (const ending of ['', '\r', '\r\n']) {
            const original = Buffer.from(`Algorithm=SHA-256\r\n# Vendor comment${ending}`);
            writeFileSync(target, original);
            assert.equal(updateBlocklist(target, FINGERPRINTS), 16);
            assert.ok(readFileSync(target).subarray(0, original.length).equals(original));
        }
    });

    it('discovers both blocklist filenames and preserves symlinks and paths with shell characters', () => {
        for (const name of ['blocked.certs', 'blacklisted.certs']) {
            const home = path.join(directory, `JDK with spaces and $(echo no) '${name}'`, 'jre');
            const security = path.join(home, 'lib', 'security');
            mkdirSync(security, {recursive: true});
            const link = path.join(security, name);
            symlinkSync(target, link);
            assert.equal(resolveBlocklist(home), realpathSync(target));
            updateBlocklist(resolveBlocklist(home), FINGERPRINTS);
            assert.ok(lstatSync(link).isSymbolicLink());
        }
    });

    it('fails on missing, ambiguous, or non-file blocklists without creating one', () => {
        assert.throws(() => resolveBlocklist(directory), /exactly one/);
        const security = path.join(directory, 'lib', 'security');
        mkdirSync(path.join(security, 'blocked.certs'), {recursive: true});
        assert.throws(() => resolveBlocklist(directory), /regular file/);
        writeFileSync(path.join(security, 'blacklisted.certs'), VENDOR_CONTENT);
        assert.throws(() => resolveBlocklist(directory), /exactly one/);
        assert.throws(() => updateBlocklist(path.join(directory, 'missing.certs'), FINGERPRINTS), /ENOENT/);
    });

    it('does not modify a malformed vendor blocklist', () => {
        const blocklist = target;
        for (const content of ['Algorithm=SHA-512\n', 'Algorithm=SHA-256\nAlgorithm SHA-512\n', 'Algorithm=SHA-256\nother=continued\\\n']) {
            writeFileSync(blocklist, content);
            assert.throws(() => updateBlocklist(blocklist, FINGERPRINTS));
            assert.equal(readFileSync(blocklist, 'utf8'), content);
        }
    });
});
