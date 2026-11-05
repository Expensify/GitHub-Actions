import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import type {PullRequestContent} from '../scripts/openNodeBumpPullRequests';
import OpenNodeBumpPullRequests from '../scripts/openNodeBumpPullRequests';
import createNodeReleases from './createNodeReleases';

const releases = createNodeReleases();

function getRelease(version: string) {
    const release = releases.find((candidate) => candidate.version === version);
    assert.ok(release, `Missing fixture release ${version}`);
    return release;
}

const ISSUE_URL = 'https://github.com/Expensify/Expensify/issues/700000';

const exactBump: PullRequestContent = {
    repo: {name: 'App'},
    from: getRelease('26.12.1'),
    to: getRelease('26.13.1'),
    floats: false,
    includesSecurityFix: true,
    issueURL: ISSUE_URL,
};

const buildBoxRepo = {name: 'Web-Expensify', securityReleaseTitlePrefix: '[CP Staging & Prod]', holdForBuildBoxes: true};

describe('openNodeBumpPullRequests', () => {
    describe('getPullRequestTitle', () => {
        it('titles an exact bump', () => {
            assert.equal(OpenNodeBumpPullRequests.getPullRequestTitle(exactBump), '[No QA] Bump Node.js to 26.13.1');
        });

        it('holds and cherry-picks a security fix for a repo built on the build boxes', () => {
            assert.equal(OpenNodeBumpPullRequests.getPullRequestTitle({...exactBump, repo: buildBoxRepo}), '[HOLD] [CP Staging & Prod] [No QA] Bump Node.js to 26.13.1');
        });

        it('only cherry-picks security fixes', () => {
            assert.equal(OpenNodeBumpPullRequests.getPullRequestTitle({...exactBump, repo: buildBoxRepo, includesSecurityFix: false}), '[HOLD] [No QA] Bump Node.js to 26.13.1');
        });

        it('titles a raised minimum', () => {
            assert.equal(OpenNodeBumpPullRequests.getPullRequestTitle({...exactBump, floats: true}), '[No QA] Require Node.js 26.13.1 or newer');
        });
    });

    describe('getPullRequestBody', () => {
        it('explains an exact bump, including the npm change, and links the issue', () => {
            const body = OpenNodeBumpPullRequests.getPullRequestBody(exactBump);
            assert.match(body, /Moves Node\.js from 26\.12\.1 to \[26\.13\.1\]\(https:\/\/nodejs\.org\/en\/blog\/release\/v26\.13\.1\), which includes security fixes/);
            assert.match(body, /npm moves from 11\.20\.0 to 11\.21\.0/);
            assert.match(body, /^For https:\/\/github\.com\/Expensify\/Expensify\/issues\/700000$/m);
            assert.doesNotMatch(body, /build boxes/);
        });

        it('explains a raised minimum and when to merge it for a repo built on the build boxes', () => {
            const body = OpenNodeBumpPullRequests.getPullRequestBody({...exactBump, repo: buildBoxRepo, floats: true});
            assert.match(body, /Raises the minimum Node\.js version from 26\.12\.1 to/);
            assert.match(body, /Merge this only after the build boxes run Node\.js 26\.13\.1 or newer/);
        });
    });

    describe('getCoAuthorTrailer', () => {
        it('uses the noreply address that peer review resolves to a login', () => {
            assert.equal(OpenNodeBumpPullRequests.getCoAuthorTrailer('NicolasBonet', '13696500'), 'Co-authored-by: NicolasBonet <13696500+NicolasBonet@users.noreply.github.com>');
        });

        it('is empty without a login and rejects a non-numeric ID', () => {
            assert.equal(OpenNodeBumpPullRequests.getCoAuthorTrailer('', ''), '');
            assert.throws(() => OpenNodeBumpPullRequests.getCoAuthorTrailer('NicolasBonet', 'abc'), /numeric GitHub user ID/);
        });
    });

    describe('getResultsTable', () => {
        it('escapes characters that would break the Markdown table', () => {
            assert.equal(
                OpenNodeBumpPullRequests.getResultsTable([{repo: 'App', outcome: 'Failed: a | b\nc', failed: true}]),
                '| Repo | Result |\n| --- | --- |\n| App | Failed: a \\| b c |',
            );
        });
    });
});
