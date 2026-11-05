import {execFileSync} from 'node:child_process';
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';

import type {NodeRelease} from './NodeReleaseUtils';
import NodeReleaseUtils from './NodeReleaseUtils';

/**
 * Sparse-checkout patterns (gitignore syntax) covering every file this module reads or changes.
 */
const SPARSE_CHECKOUT_PATTERNS = ['/.nvmrc', 'package.json', 'package-lock.json', 'checkRuntimeVersions.sh'];

const VERSION_FILE_PATHSPECS = [':(glob)**/package.json', ':(glob)**/package-lock.json', ':(glob)**/checkRuntimeVersions.sh'];

const EXACT_VERSION_PATTERN = /^v?\d+\.\d+\.\d+$/;

/**
 * `.nvmrc` either pins an exact release, or floats on a major line and lets CI install its newest release.
 */
type NvmrcPin = {type: 'exact'; version: string} | {type: 'major'; major: number};

type RepoBumpPlan = {status: 'bump'; from: NodeRelease; to: NodeRelease; floats: boolean} | {status: 'skipped'; reason: string};

/**
 * Callbacks that receive each Node.js and npm version a version file pins, and return its replacement.
 * Node.js versions come from both exact pins and ranges (minimums), npm versions only from exact pins.
 */
type VersionVisitor = {
    node: (version: string) => string;
    npm: (version: string) => string;
};

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseNvmrc(content: string): NvmrcPin | null {
    const value = content.trim().replace(/^v/, '');
    if (/^\d+$/.test(value)) {
        return {type: 'major', major: Number(value)};
    }

    const version = NodeReleaseUtils.normalizeNodeVersion(value);
    return version ? {type: 'exact', version} : null;
}

function readNvmrc(repoDir: string): NvmrcPin | null {
    const nvmrcPath = path.join(repoDir, '.nvmrc');
    return existsSync(nvmrcPath) ? parseNvmrc(readFileSync(nvmrcPath, 'utf8')) : null;
}

/**
 * Applies `visit` to every version in a range such as "26.12.1", ">=26.12.1" or ">=24.22.1 <25 || >=26.12.1".
 * Upper bounds ("<27.0.0") are not pins, so they are left alone.
 */
function visitRange(range: string, visit: (version: string) => string): string {
    return range.replaceAll(/(?<![\d.])\d+\.\d+\.\d+(?![\d.])/g, (version: string, offset: number) => {
        const operator = range.slice(0, offset).trimEnd();
        return operator.endsWith('<') || operator.endsWith('<=') ? version : visit(version);
    });
}

/**
 * Applies the visitor to the Node.js and npm versions in a package.json manifest, or the root entry of a package-lock.json.
 * Returns the number of values it changed.
 */
function visitManifest(manifest: unknown, visitor: VersionVisitor): number {
    if (!isJsonObject(manifest)) {
        return 0;
    }

    let changeCount = 0;
    const update = (object: unknown, key: string, visit: (value: string) => string) => {
        if (!isJsonObject(object)) {
            return;
        }
        const value = object[key];
        if (typeof value !== 'string') {
            return;
        }
        const updated = visit(value);
        if (updated !== value) {
            // eslint-disable-next-line no-param-reassign -- the manifest is parsed JSON that is serialized again after this
            object[key] = updated;
            changeCount++;
        }
    };
    const visitNodeRange = (value: string) => visitRange(value, visitor.node);
    const visitNpmPin = (value: string) => (EXACT_VERSION_PATTERN.test(value) ? visitor.npm(value) : value);

    update(manifest.engines, 'node', visitNodeRange);
    update(manifest.engines, 'npm', visitNpmPin);

    const devEngines = manifest.devEngines;
    if (isJsonObject(devEngines)) {
        if (isJsonObject(devEngines.runtime) && devEngines.runtime.name === 'node') {
            update(devEngines.runtime, 'version', visitNodeRange);
        }
        if (isJsonObject(devEngines.packageManager) && devEngines.packageManager.name === 'npm') {
            update(devEngines.packageManager, 'version', visitNpmPin);
        }
    }

    return changeCount;
}

/**
 * Applies the visitor to a JSON file and keeps its formatting, by refusing any rewrite that changes more lines than values.
 */
function visitJsonFile(file: string, content: string, getManifest: (json: unknown) => unknown, visitor: VersionVisitor): string {
    const json: unknown = JSON.parse(content);
    const changeCount = visitManifest(getManifest(json), visitor);
    if (changeCount === 0) {
        return content;
    }

    const indent = /^[ \t]+/m.exec(content)?.at(0) ?? '  ';
    const rewritten = `${JSON.stringify(json, null, indent)}${content.endsWith('\n') ? '\n' : ''}`;
    const originalLines = content.split('\n');
    const rewrittenLines = rewritten.split('\n');
    const changedLineCount = rewrittenLines.filter((line, index) => line !== originalLines.at(index)).length;
    if (originalLines.length !== rewrittenLines.length || changedLineCount !== changeCount) {
        throw new Error(`Updating ${file} would reformat it, so update it by hand`);
    }
    return rewritten;
}

/**
 * checkRuntimeVersions.sh either requires an exact version (desiredNodeVersion) or a minimum on a major line (minimumNodeVersion).
 */
function visitCheckRuntimeVersions(content: string, visitor: VersionVisitor): string {
    return content
        .replaceAll(/^((?:desired|minimum)NodeVersion="v?)(\d+\.\d+\.\d+)(")$/gm, (_match, prefix: string, version: string, suffix: string) => `${prefix}${visitor.node(version)}${suffix}`)
        .replaceAll(/^((?:desired|minimum)NpmVersion=")(\d+\.\d+\.\d+)(")$/gm, (_match, prefix: string, version: string, suffix: string) => `${prefix}${visitor.npm(version)}${suffix}`);
}

function visitFileContent(file: string, content: string, visitor: VersionVisitor): string {
    switch (path.basename(file)) {
        case 'package.json':
            return visitJsonFile(file, content, (json) => json, visitor);
        case 'package-lock.json':
            return visitJsonFile(file, content, (json) => (isJsonObject(json) && isJsonObject(json.packages) ? json.packages[''] : undefined), visitor);
        case 'checkRuntimeVersions.sh':
            return visitCheckRuntimeVersions(content, visitor);
        default:
            return content;
    }
}

/**
 * Runs the visitor over every version file in the repo and writes the ones it changes. Returns the changed files.
 */
function visitVersionFiles(repoDir: string, visitor: VersionVisitor): string[] {
    const files = execFileSync('git', ['ls-files', '-z', '--', ...VERSION_FILE_PATHSPECS], {cwd: repoDir, encoding: 'utf8'})
        .split('\0')
        .filter(Boolean);

    const changedFiles: string[] = [];
    for (const file of files) {
        const filePath = path.join(repoDir, file);

        // A sparse checkout only has the files matching SPARSE_CHECKOUT_PATTERNS on disk.
        if (!existsSync(filePath)) {
            continue;
        }

        const content = readFileSync(filePath, 'utf8');
        const updated = visitFileContent(file, content, visitor);
        if (updated !== content) {
            writeFileSync(filePath, updated);
            changedFiles.push(file);
        }
    }
    return changedFiles;
}

/**
 * Finds the highest minimum Node.js version on `major` that the repo's version files require, for a repo that floats on that line.
 */
function findMinimumNodeVersion(repoDir: string, major: number): string | null {
    const minimums: string[] = [];
    visitVersionFiles(repoDir, {
        node: (version) => {
            if (NodeReleaseUtils.getMajor(version) === major) {
                minimums.push(version);
            }
            return version;
        },
        npm: (version) => version,
    });
    return minimums.sort(NodeReleaseUtils.compareVersions).at(-1) ?? null;
}

/**
 * Decides whether and how far to bump a repo.
 * A repo that pins an exact release moves to the requested release on its line, or to the newest release on its line when no release is requested.
 * A repo that floats on its line already gets every release, so it only changes when a release is requested, and then raises its minimums to it.
 */
function planRepoBump(repoDir: string, releases: NodeRelease[], requestedReleases: NodeRelease[] = []): RepoBumpPlan {
    const pin = readNvmrc(repoDir);
    if (!pin) {
        return {status: 'skipped', reason: '.nvmrc is missing or does not hold a Node.js version'};
    }

    let currentVersion: string;
    if (pin.type === 'exact') {
        currentVersion = pin.version;
    } else {
        if (requestedReleases.length === 0) {
            return {status: 'skipped', reason: `Floats on Node.js ${pin.major}.x`};
        }
        const minimum = findMinimumNodeVersion(repoDir, pin.major);
        if (!minimum) {
            return {status: 'skipped', reason: `Floats on Node.js ${pin.major}.x without a minimum to raise`};
        }
        currentVersion = minimum;
    }

    const target = NodeReleaseUtils.resolveBumpTarget(releases, currentVersion, requestedReleases);
    switch (target.status) {
        case 'bump':
            return {status: 'bump', from: target.from, to: target.to, floats: pin.type === 'major'};
        case 'up-to-date':
            return {status: 'skipped', reason: pin.type === 'exact' ? `Already on Node.js ${target.version}` : `Already requires Node.js ${target.version} or newer`};
        default:
            return {status: 'skipped', reason: target.reason};
    }
}

/**
 * Raises every Node.js version on `to`'s major line that is older than `to`: the exact release in .nvmrc, exact pins and minimums in package.json,
 * package-lock.json and checkRuntimeVersions.sh. npm is only bumped where it is pinned to exactly the npm bundled with `from`,
 * so minimums such as ">=11.10.0" stay put. Returns the changed files.
 */
function bumpNodeVersionFiles(repoDir: string, from: NodeRelease, to: NodeRelease): string[] {
    const raise = (version: string) => {
        const isOlderOnLine = NodeReleaseUtils.getMajor(version) === NodeReleaseUtils.getMajor(to.version) && NodeReleaseUtils.compareVersions(version, to.version) < 0;
        return isOlderOnLine ? to.version : version;
    };

    const changedFiles: string[] = [];
    const nvmrcPath = path.join(repoDir, '.nvmrc');
    const nvmrc = readFileSync(nvmrcPath, 'utf8');
    const pin = parseNvmrc(nvmrc);
    if (pin?.type === 'exact' && raise(pin.version) !== pin.version) {
        // Keeps the file's own format, since some tools need it (Cloudflare Workers Builds reads "v26.12.1" without a trailing newline).
        writeFileSync(nvmrcPath, nvmrc.replace(pin.version, to.version));
        changedFiles.push('.nvmrc');
    }

    return [
        ...changedFiles,
        ...visitVersionFiles(repoDir, {
            node: raise,
            npm: (version) => (version === from.npm ? to.npm : version),
        }),
    ];
}

export type {NvmrcPin, RepoBumpPlan};

export {SPARSE_CHECKOUT_PATTERNS};

export default {
    bumpNodeVersionFiles,
    findMinimumNodeVersion,
    parseNvmrc,
    planRepoBump,
    readNvmrc,
};
