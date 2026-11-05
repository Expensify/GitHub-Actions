import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import NodeReleaseUtils from '../scripts/libs/NodeReleaseUtils';
import createNodeReleases from './createNodeReleases';

const releases = createNodeReleases();

function getRelease(version: string) {
    const release = releases.find((candidate) => candidate.version === version);
    assert.ok(release, `Missing fixture release ${version}`);
    return release;
}

describe('NodeReleaseUtils', () => {
    describe('parseNodeReleases', () => {
        it('strips the leading v and drops releases without a bundled npm', () => {
            assert.deepEqual(
                NodeReleaseUtils.parseNodeReleases([
                    {version: 'v26.13.1', npm: '11.21.0', security: true, date: '2026-11-11'},
                    {version: 'v0.4.0', security: false, date: '2011-08-26'},
                ]),
                [{version: '26.13.1', npm: '11.21.0', security: true, date: '2026-11-11'}],
            );
        });
    });

    describe('normalizeNodeVersion', () => {
        it('accepts exact versions with or without a leading v', () => {
            assert.equal(NodeReleaseUtils.normalizeNodeVersion('v26.12.1\n'), '26.12.1');
            assert.equal(NodeReleaseUtils.normalizeNodeVersion('24.22.1'), '24.22.1');
        });

        it('rejects anything that is not an exact version', () => {
            assert.equal(NodeReleaseUtils.normalizeNodeVersion('24'), null);
            assert.equal(NodeReleaseUtils.normalizeNodeVersion('lts/*'), null);
        });
    });

    describe('compareVersions', () => {
        it('compares each part numerically', () => {
            assert.ok(NodeReleaseUtils.compareVersions('26.12.10', '26.12.9') > 0);
            assert.ok(NodeReleaseUtils.compareVersions('24.22.1', '26.0.0') < 0);
            assert.equal(NodeReleaseUtils.compareVersions('26.13.0', '26.13.0'), 0);
        });
    });

    describe('getNewerReleasesOnLine', () => {
        it('returns newer releases on the same major line, newest first', () => {
            assert.deepEqual(
                NodeReleaseUtils.getNewerReleasesOnLine(releases, '26.12.1').map((release) => release.version),
                ['26.13.1', '26.13.0'],
            );
        });
    });

    describe('includesSecurityFix', () => {
        it('is true when a security release lands between the two versions', () => {
            assert.equal(NodeReleaseUtils.includesSecurityFix(releases, getRelease('26.12.0'), getRelease('26.13.0')), true);
        });

        it('is false when only regular releases land between the two versions', () => {
            assert.equal(NodeReleaseUtils.includesSecurityFix(releases, getRelease('26.12.1'), getRelease('26.13.0')), false);
        });
    });

    describe('findRecentSecurityReleases', () => {
        it('returns the newest recent security release on each line', () => {
            const recent = NodeReleaseUtils.findRecentSecurityReleases(releases, [24, 26, 26], new Date('2026-11-12T00:00:00Z'), 14);
            assert.deepEqual(
                recent.map((release) => release.version),
                ['26.13.1', '24.22.3'],
            );
        });

        it('ignores security releases older than the cutoff', () => {
            assert.deepEqual(NodeReleaseUtils.findRecentSecurityReleases(releases, [24, 26], new Date('2026-12-30T00:00:00Z'), 14), []);
        });
    });

    describe('findRequestedReleases', () => {
        it('returns nothing when no version is requested', () => {
            assert.deepEqual(NodeReleaseUtils.findRequestedReleases(releases, ''), []);
        });

        it('finds one published release per line', () => {
            assert.deepEqual(
                NodeReleaseUtils.findRequestedReleases(releases, 'v26.13.0, 24.22.3').map((release) => release.version),
                ['26.13.0', '24.22.3'],
            );
        });

        it('throws for a version that was never published', () => {
            assert.throws(() => NodeReleaseUtils.findRequestedReleases(releases, '26.99.0'), /not a published Node.js release/);
        });

        it('throws for two versions on the same line', () => {
            assert.throws(() => NodeReleaseUtils.findRequestedReleases(releases, '26.13.0,26.13.1'), /at most one Node.js version per major line/);
        });
    });

    describe('resolveBumpTarget', () => {
        it('moves to the newest release on the line by default', () => {
            const target = NodeReleaseUtils.resolveBumpTarget(releases, '26.12.1');
            assert.equal(target.status, 'bump');
            assert.equal(target.status === 'bump' && target.to.version, '26.13.1');
        });

        it('moves to the requested release on the same line', () => {
            const target = NodeReleaseUtils.resolveBumpTarget(releases, '26.12.1', [getRelease('24.22.3'), getRelease('26.13.0')]);
            assert.equal(target.status === 'bump' && target.to.version, '26.13.0');
        });

        it('skips a repo when no requested release is on its line', () => {
            assert.deepEqual(NodeReleaseUtils.resolveBumpTarget(releases, '24.22.1', [getRelease('26.13.1')]), {status: 'skipped', reason: 'No requested release on the Node.js 24.x line'});
        });

        it('reports a repo that is already on the target', () => {
            assert.deepEqual(NodeReleaseUtils.resolveBumpTarget(releases, '26.13.1'), {status: 'up-to-date', version: '26.13.1'});
            assert.deepEqual(NodeReleaseUtils.resolveBumpTarget(releases, '26.13.1', [getRelease('26.13.0')]), {status: 'up-to-date', version: '26.13.1'});
        });

        it('skips a version that was never published', () => {
            assert.equal(NodeReleaseUtils.resolveBumpTarget(releases, '26.99.0').status, 'skipped');
        });
    });
});
