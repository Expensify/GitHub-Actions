import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {$} from 'bun';

// Bun runs the source directly; consumers do not install this repository's npm dependencies.
import {certificateFingerprints, parseJavaRuntime, resolveBlocklist, updateBlocklist} from './libs/JavaCertificateBlocklist';

const SCRIPT = fileURLToPath(import.meta.url);
// Source: https://emudhra.we-have-a-problem.com/impacted-intermediates.json
const CERTIFICATES = new URL('../block-compromised-java-certificates/compromised-java-certificates.pem', import.meta.url);

async function main() {
    if (!['linux', 'darwin'].includes(process.platform)) {
        throw new Error('This action supports Linux and macOS.');
    }
    const fingerprints = certificateFingerprints(await Bun.file(CERTIFICATES).text());

    // Only the file update can be elevated, never Java execution or runtime discovery.
    const [, , mode, updateTarget] = process.argv;
    if (mode === '--update-blocklist' && process.argv.length === 4 && path.isAbsolute(updateTarget)) {
        const added = await updateBlocklist(updateTarget, fingerprints);
        console.log(`Verified all ${fingerprints.length} compromised certificates in ${updateTarget}; added ${added} fingerprints.`);
        return;
    }
    if (process.argv.length !== 2) {
        throw new Error('Unexpected arguments.');
    }

    // An omitted composite-action input is an empty string, not undefined.
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
    const javaHome = process.env.BLOCKLIST_JAVA_HOME || process.env.JAVA_HOME;
    if (!javaHome || !path.isAbsolute(javaHome)) {
        throw new Error('Set JAVA_HOME with actions/setup-java, or provide an absolute java-home input.');
    }
    const java = path.join(javaHome, 'bin', 'java');
    const inspection = await $`${java} -XshowSettings:properties -version`.quiet().nothrow();
    if (inspection.exitCode !== 0) {
        // JVM diagnostics may echo secret-bearing JAVA_TOOL_OPTIONS. Do not print captured output on failure.
        throw new Error('Cannot inspect the selected JVM.');
    }
    const runtime = parseJavaRuntime(`${inspection.stdout.toString()}\n${inspection.stderr.toString()}`);
    console.log(`Selected JVM: ${runtime.vendor} ${runtime.version}; java.home=${runtime.home}`);
    const target = await resolveBlocklist(runtime.home);

    let added: number;
    try {
        added = await updateBlocklist(target, fingerprints);
    } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || !['EACCES', 'EPERM'].includes(String(error.code))) {
            throw error;
        }
        // Use absolute paths because sudo need not retain the caller's PATH or JAVA_HOME.
        const elevated = await $`sudo -n ${process.execPath} --no-env-file ${SCRIPT} --update-blocklist ${target}`.quiet().nothrow();
        if (elevated.exitCode !== 0) {
            throw new Error(`Cannot update the JVM certificate blocklist using noninteractive sudo: ${elevated.stderr.toString()}`);
        }
        console.log(elevated.stdout.toString().trim());
        return;
    }
    console.log(`Verified all ${fingerprints.length} compromised certificates in ${target}; added ${added} fingerprints.`);
}

if (import.meta.main) {
    main().catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : 'Unable to protect the selected JVM.');
        process.exitCode = 1;
    });
}
