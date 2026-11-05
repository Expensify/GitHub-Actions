/* eslint-disable @typescript-eslint/naming-convention -- fixture keys are file paths and package-lock.json entries */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, describe, it} from 'node:test';

import NodeBumpUtils from '../scripts/libs/NodeBumpUtils';
import createNodeReleases from './createNodeReleases';

const releases = createNodeReleases();
const repoDirs: string[] = [];

function toJson(value: unknown): string {
    return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Creates a git repo holding `files`, with every file staged so `git ls-files` lists it.
 */
function createRepo(files: Record<string, string>): string {
    const repoDir = mkdtempSync(path.join(os.tmpdir(), 'node-bump-test-'));
    repoDirs.push(repoDir);
    for (const [file, content] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(repoDir, file)), {recursive: true});
        writeFileSync(path.join(repoDir, file), content);
    }
    execFileSync('git', ['init', '--quiet'], {cwd: repoDir});
    execFileSync('git', ['add', '--all'], {cwd: repoDir});
    return repoDir;
}

function read(repoDir: string, file: string): string {
    return readFileSync(path.join(repoDir, file), 'utf8');
}

function getRelease(version: string) {
    const release = releases.find((candidate) => candidate.version === version);
    assert.ok(release, `Missing fixture release ${version}`);
    return release;
}

function bump(repoDir: string, requestedVersions: string[] = []): string[] {
    const plan = NodeBumpUtils.planRepoBump(repoDir, releases, requestedVersions.map(getRelease));
    assert.equal(plan.status, 'bump', plan.status === 'skipped' ? plan.reason : '');
    return plan.status === 'bump' ? NodeBumpUtils.bumpNodeVersionFiles(repoDir, plan.from, plan.to) : [];
}

after(() => {
    for (const repoDir of repoDirs) {
        rmSync(repoDir, {recursive: true, force: true});
    }
});

describe('NodeBumpUtils', () => {
    describe('parseNvmrc', () => {
        it('reads an exact release or a major line', () => {
            assert.deepEqual(NodeBumpUtils.parseNvmrc('v26.12.1'), {type: 'exact', version: '26.12.1'});
            assert.deepEqual(NodeBumpUtils.parseNvmrc('24\n'), {type: 'major', major: 24});
            assert.equal(NodeBumpUtils.parseNvmrc('lts/*'), null);
        });
    });

    describe('repos that pin an exact release', () => {
        it('bumps .nvmrc, engines and the package-lock.json root entry, and npm along with Node.js', () => {
            const repoDir = createRepo({
                '.nvmrc': '26.12.1\n',
                'package.json': toJson({name: 'app', engines: {node: '26.12.1', npm: '11.20.0'}}),
                'package-lock.json': toJson({name: 'app', lockfileVersion: 3, packages: {'': {name: 'app', engines: {node: '26.12.1', npm: '11.20.0'}}}}),
            });

            assert.deepEqual(bump(repoDir).sort(), ['.nvmrc', 'package-lock.json', 'package.json']);
            assert.equal(read(repoDir, '.nvmrc'), '26.13.1\n');
            assert.equal(read(repoDir, 'package.json'), toJson({name: 'app', engines: {node: '26.13.1', npm: '11.21.0'}}));
            assert.equal(read(repoDir, 'package-lock.json'), toJson({name: 'app', lockfileVersion: 3, packages: {'': {name: 'app', engines: {node: '26.13.1', npm: '11.21.0'}}}}));
        });

        it('bumps an exact checkRuntimeVersions.sh', () => {
            const repoDir = createRepo({
                '.nvmrc': '26.12.1\n',
                '_tools/deploy/checkRuntimeVersions.sh': '#!/bin/bash\ndesiredNpmVersion="11.20.0"\ndesiredNodeVersion="v26.12.1"\n',
            });

            bump(repoDir);
            assert.equal(read(repoDir, '_tools/deploy/checkRuntimeVersions.sh'), '#!/bin/bash\ndesiredNpmVersion="11.21.0"\ndesiredNodeVersion="v26.13.1"\n');
        });

        it('keeps the format of .nvmrc', () => {
            const repoDir = createRepo({'.nvmrc': 'v26.12.1'});
            bump(repoDir);
            assert.equal(read(repoDir, '.nvmrc'), 'v26.13.1');
        });

        it('raises minimums but leaves npm minimums and upper bounds alone', () => {
            const repoDir = createRepo({
                '.nvmrc': '24.22.1\n',
                'package.json': toJson({
                    devEngines: {
                        runtime: {name: 'node', version: '>=24.22.1 <24.30.0', onFail: 'error'},
                        packageManager: {name: 'npm', version: '>=11.10.0', onFail: 'error'},
                    },
                }),
            });

            bump(repoDir);
            assert.equal(read(repoDir, '.nvmrc'), '24.22.3\n');
            assert.equal(
                read(repoDir, 'package.json'),
                toJson({
                    devEngines: {
                        runtime: {name: 'node', version: '>=24.22.3 <24.30.0', onFail: 'error'},
                        packageManager: {name: 'npm', version: '>=11.10.0', onFail: 'error'},
                    },
                }),
            );
        });

        it('skips a repo that is already on the newest release', () => {
            const repoDir = createRepo({'.nvmrc': '26.13.1\n'});
            assert.deepEqual(NodeBumpUtils.planRepoBump(repoDir, releases), {status: 'skipped', reason: 'Already on Node.js 26.13.1'});
        });

        it('moves to the requested release on its line', () => {
            const repoDir = createRepo({'.nvmrc': '26.12.1\n'});
            bump(repoDir, ['24.22.3', '26.13.0']);
            assert.equal(read(repoDir, '.nvmrc'), '26.13.0\n');
        });

        it('refuses to reformat a JSON file', () => {
            const repoDir = createRepo({
                '.nvmrc': '26.12.1\n',
                'package.json': '{"name": "app", "engines": {"node": "26.12.1"}}\n',
            });
            assert.throws(() => bump(repoDir), /would reformat it/);
        });
    });

    describe('repos that float on a major line', () => {
        const createFloatingRepo = () =>
            createRepo({
                '.nvmrc': '26',
                'tools/checkRuntimeVersions.sh': '#!/bin/bash\nminimumNodeVersion="26.12.1"\nminimumNpmVersion="11.10.0"\n',
                'worker/package.json': toJson({devEngines: {runtime: {name: 'node', version: '>=24.22.1 <25 || >=26.12.1', onFail: 'error'}}}),
            });

        it('skips them when no release is requested, since they already get every release', () => {
            assert.deepEqual(NodeBumpUtils.planRepoBump(createFloatingRepo(), releases), {status: 'skipped', reason: 'Floats on Node.js 26.x'});
        });

        it('raises their minimums to the requested release and leaves .nvmrc and other lines alone', () => {
            const repoDir = createFloatingRepo();
            const plan = NodeBumpUtils.planRepoBump(repoDir, releases, [getRelease('26.13.1')]);
            assert.equal(plan.status === 'bump' && plan.floats, true);

            assert.deepEqual(bump(repoDir, ['26.13.1', '24.22.3']).sort(), ['tools/checkRuntimeVersions.sh', 'worker/package.json']);
            assert.equal(read(repoDir, '.nvmrc'), '26');
            assert.equal(read(repoDir, 'tools/checkRuntimeVersions.sh'), '#!/bin/bash\nminimumNodeVersion="26.13.1"\nminimumNpmVersion="11.10.0"\n');
            assert.equal(read(repoDir, 'worker/package.json'), toJson({devEngines: {runtime: {name: 'node', version: '>=24.22.1 <25 || >=26.13.1', onFail: 'error'}}}));
        });

        it('skips them when they have no minimum to raise', () => {
            const repoDir = createRepo({'.nvmrc': '24\n'});
            assert.deepEqual(NodeBumpUtils.planRepoBump(repoDir, releases, [getRelease('24.22.3')]), {status: 'skipped', reason: 'Floats on Node.js 24.x without a minimum to raise'});
        });
    });
});
