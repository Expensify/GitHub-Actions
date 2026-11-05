import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import type {RepoPin} from '../scripts/detectNodeSecurityRelease';
import DetectNodeSecurityRelease from '../scripts/detectNodeSecurityRelease';
import createNodeReleases from './createNodeReleases';

const releases = createNodeReleases();
const securityReleases = releases.filter((release) => release.version === '26.13.1' || release.version === '24.22.3');

const repoPins: RepoPin[] = [
    {name: 'App', pin: {type: 'exact', version: '26.12.1'}, holdForBuildBoxes: false},
    {name: 'Web-Expensify', pin: {type: 'major', major: 26}, holdForBuildBoxes: true},
    {name: 'expensify-common', pin: {type: 'major', major: 24}, holdForBuildBoxes: false},
];

describe('detectNodeSecurityRelease', () => {
    describe('getTrackingIssueTitle', () => {
        it('names every release', () => {
            assert.equal(DetectNodeSecurityRelease.getTrackingIssueTitle(securityReleases), 'Roll out the Node.js 26.13.1 and 24.22.3 security releases');
            assert.equal(DetectNodeSecurityRelease.getTrackingIssueTitle(securityReleases.slice(1)), 'Roll out the Node.js 24.22.3 security release');
        });
    });

    describe('mentionsRelease', () => {
        it('matches the exact version in a Node.js issue title', () => {
            assert.equal(DetectNodeSecurityRelease.mentionsRelease('Roll out the Node.js 26.13.1 and 24.22.3 security releases', '24.22.3'), true);
        });

        it('does not match a longer version or an unrelated title', () => {
            assert.equal(DetectNodeSecurityRelease.mentionsRelease('Roll out the Node.js 26.13.10 security release', '26.13.1'), false);
            assert.equal(DetectNodeSecurityRelease.mentionsRelease('Upgrade grafana to 26.13.1', '26.13.1'), false);
        });
    });

    describe('getTrackingIssueBody', () => {
        it('splits the repos on each line by how they pin Node.js', () => {
            const body = DetectNodeSecurityRelease.getTrackingIssueBody(securityReleases, repoPins);
            assert.match(body, /\| \[26\.13\.1\]\(https:\/\/nodejs\.org\/en\/blog\/release\/v26\.13\.1\) \| 11\.21\.0 \| App \| Web-Expensify \|/);
            assert.match(body, /\| \[24\.22\.3\]\(.+\) \| 11\.19\.1 \| None \| expensify-common \|/);
        });

        it('tells people which versions to run the workflow with', () => {
            assert.match(DetectNodeSecurityRelease.getTrackingIssueBody(securityReleases, repoPins), /`VERSION` set to `26\.13\.1,24\.22\.3`/);
        });

        it('asks for the build boxes only when a repo built there is on a released line', () => {
            assert.match(DetectNodeSecurityRelease.getTrackingIssueBody(securityReleases, repoPins), /build boxes, which build Web-Expensify/);
            assert.doesNotMatch(DetectNodeSecurityRelease.getTrackingIssueBody(securityReleases.slice(1), repoPins), /build boxes/);
        });
    });
});
