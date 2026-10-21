import {afterEach, beforeEach, describe, it} from 'bun:test';
import assert from 'node:assert/strict';
import {createHash, X509Certificate} from 'node:crypto';
import {chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {blockedFingerprints, certificateFingerprints, parseJavaRuntime, resolveBlocklist, updateBlocklist} from '../../scripts/libs/JavaCertificateBlocklist';

const CERTIFICATES = await Bun.file(new URL('../../block-compromised-java-certificates/compromised-java-certificates.pem', import.meta.url)).text();
const FINGERPRINTS = certificateFingerprints(CERTIFICATES);
const PEMS = CERTIFICATES.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
const [FIRST_CERTIFICATE] = PEMS;
const [FIRST_FINGERPRINT, SECOND_FINGERPRINT, THIRD_FINGERPRINT, FOURTH_FINGERPRINT] = FINGERPRINTS;
const VENDOR_CONTENT = Buffer.from(`Algorithm=SHA-256\n# Vendor entry; keep comments and ordering\n${'F'.repeat(64)}\n`);

describe('Java certificate bundle', () => {
    it('derives all 16 distinct certificate fingerprints, not SPKI hashes', () => {
        assert.equal(FINGERPRINTS.length, 16);
        assert.equal(new Set(FINGERPRINTS).size, 16);
        const actual = PEMS.map((pem) => createHash('sha256').update(new X509Certificate(pem).raw).digest('hex').toUpperCase());
        assert.equal(PEMS.length, 16);
        assert.deepEqual(actual.sort(), [...FINGERPRINTS].sort());
    });

    it('rejects missing, duplicate, malformed, or unexpected certificate data', () => {
        for (const bundle of [PEMS.slice(1).join('\n'), [...PEMS, FIRST_CERTIFICATE].join('\n'), PEMS.map(() => FIRST_CERTIFICATE).join('\n'), `${CERTIFICATES}unexpected`, 'bad']) {
            assert.throws(() => certificateFingerprints(bundle), /16 distinct PEM certificates/);
        }
        const malformed = '-----BEGIN CERTIFICATE-----\nYmFk\n-----END CERTIFICATE-----';
        assert.throws(() => certificateFingerprints([malformed, ...PEMS.slice(1)].join('\n')));
    });

    it('does not execute the CLI when imported', () => {
        const script = fileURLToPath(new URL('../../scripts/blockCompromisedJavaCertificates.ts', import.meta.url));
        const result = Bun.spawnSync([process.execPath, '--no-env-file', '-e', `await import(${JSON.stringify(script)})`], {
            env: {...process.env, JAVA_HOME: '', BLOCKLIST_JAVA_HOME: ''},
        });
        assert.equal(result.exitCode, 0, result.stderr.toString());
        assert.equal(result.stdout.toString(), '');
        assert.equal(result.stderr.toString(), '');
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

    it('appends all missing fingerprints while preserving vendor content and metadata', async () => {
        const before = statSync(target);
        assert.equal(await updateBlocklist(target, FINGERPRINTS), 16);
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

    it('is byte-for-byte idempotent and does not change mtime on a repeat run', async () => {
        await updateBlocklist(target, FINGERPRINTS);
        const content = readFileSync(target);
        const modified = statSync(target).mtimeMs;
        assert.equal(await updateBlocklist(target, FINGERPRINTS), 0);
        assert.deepEqual(readFileSync(target), content);
        assert.equal(statSync(target).mtimeMs, modified);
    });

    it('safely appends to paths containing spaces and shell characters', async () => {
        const unusualTarget = path.join(directory, "vendor ' $(echo unsafe).certs");
        await Bun.write(unusualTarget, VENDOR_CONTENT);
        assert.equal(await updateBlocklist(unusualTarget, FINGERPRINTS), 16);
        const blocked = blockedFingerprints(Buffer.from(await Bun.file(unusualTarget).bytes()));
        assert.ok(FINGERPRINTS.every((fingerprint) => blocked.has(fingerprint)));
    });

    it('adds only genuinely missing keys, not duplicate bare or key-value entries', async () => {
        writeFileSync(target, Buffer.concat([VENDOR_CONTENT, Buffer.from(`${FIRST_FINGERPRINT}=\n#${SECOND_FINGERPRINT}\n${THIRD_FINGERPRINT.toLowerCase()}\n`)]));
        assert.equal(await updateBlocklist(target, FINGERPRINTS), 15);
        assert.equal(
            readFileSync(target, 'utf8')
                .split('\n')
                .filter((line) => line === FIRST_FINGERPRINT).length,
            0,
        );
    });

    it('verifies an already-patched read-only file without needing write permission', async () => {
        await updateBlocklist(target, FINGERPRINTS);
        chmodSync(target, 0o400);
        const content = readFileSync(target);
        const before = statSync(target);
        assert.equal(await updateBlocklist(target, FINGERPRINTS), 0);
        assert.deepEqual(readFileSync(target), content);
        assert.equal(statSync(target).mode, before.mode);
        assert.equal(statSync(target).mtimeMs, before.mtimeMs);
    });

    it.each(['', '\r', '\r\n'])('preserves original bytes with line ending %j', async (ending) => {
        const original = Buffer.from(`Algorithm=SHA-256\r\n# Vendor comment${ending}`);
        writeFileSync(target, original);
        assert.equal(await updateBlocklist(target, FINGERPRINTS), 16);
        assert.ok(readFileSync(target).subarray(0, original.length).equals(original));
    });

    it.each(['blocked.certs', 'blacklisted.certs'])('discovers %s and preserves symlinks and paths with shell characters', async (name) => {
        const home = path.join(directory, `JDK with spaces and $(echo no) '${name}'`, 'jre');
        const security = path.join(home, 'lib', 'security');
        mkdirSync(security, {recursive: true});
        const link = path.join(security, name);
        symlinkSync(target, link);
        assert.equal(await resolveBlocklist(home), realpathSync(target));
        await updateBlocklist(await resolveBlocklist(home), FINGERPRINTS);
        assert.ok(lstatSync(link).isSymbolicLink());
    });

    it('fails on missing, ambiguous, or non-file blocklists without creating one', async () => {
        await assert.rejects(resolveBlocklist(directory), /exactly one/);
        const security = path.join(directory, 'lib', 'security');
        mkdirSync(path.join(security, 'blocked.certs'), {recursive: true});
        await assert.rejects(resolveBlocklist(directory), /exactly one/);
        rmSync(path.join(security, 'blocked.certs'), {recursive: true});
        writeFileSync(path.join(security, 'blocked.certs'), VENDOR_CONTENT);
        writeFileSync(path.join(security, 'blacklisted.certs'), VENDOR_CONTENT);
        await assert.rejects(resolveBlocklist(directory), /exactly one/);
        await assert.rejects(updateBlocklist(path.join(directory, 'missing.certs'), FINGERPRINTS), /ENOENT/);
    });

    it.each(['Algorithm=SHA-512\n', 'Algorithm=SHA-256\nAlgorithm SHA-512\n', 'Algorithm=SHA-256\nother=continued\\\n'])('does not modify malformed blocklist %j', async (content) => {
        writeFileSync(target, content);
        await assert.rejects(updateBlocklist(target, FINGERPRINTS));
        assert.equal(readFileSync(target, 'utf8'), content);
    });
});
