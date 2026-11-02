import assert from 'node:assert/strict';
import {afterEach, beforeEach, describe, it} from 'node:test';

import GitHubAPIClient, {type InternalOctokit} from '../scripts/libs/GitHubAPIClient';
import VerifyPeerReview from '../scripts/verifyPeerReview';

const ORIGINAL_ARGV = process.argv;

describe('main CLI parsing', () => {
    let originalExit: typeof process.exit;
    const client = new GitHubAPIClient('fake-token');
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/dot-notation -- narrow test fixture standing in for the private Octokit instance
    client['internalOctokit'] = {graphql: async () => ({repository: {ref: {branchProtectionRule: null}, pullRequest: {headRefOid: 'a'.repeat(40)}}})} as unknown as InternalOctokit;

    beforeEach(() => {
        process.argv = ['tsx', 'scripts/verifyPeerReview.ts'];
        originalExit = process.exit.bind(process);
        process.exit = (code?: string | number | null) => {
            throw new Error(`exit ${code ?? 0}`);
        };
    });

    afterEach(() => {
        process.argv = ORIGINAL_ARGV;
        process.exit = originalExit;
    });

    it('parses required pull request CLI arguments', async () => {
        process.argv.push('--owner', 'Expensify', '--repo', 'Auth', '--pull-request-number', '21136', '--target-branch', 'main', '--actor-type', 'User', '--head-sha', 'a'.repeat(40));

        await assert.doesNotReject(() => VerifyPeerReview.main(client));
    });

    it('fails when required arguments are missing', async () => {
        await assert.rejects(() => VerifyPeerReview.main(client), /exit 1/);
    });

    it('requires the head SHA from the triggering event', async () => {
        process.argv.push('--owner', 'Expensify', '--repo', 'Auth', '--pull-request-number', '21136', '--target-branch', 'main', '--actor-type', 'User');
        await assert.rejects(() => VerifyPeerReview.main(client), /exit 1/);
    });

    it('rejects malformed head SHAs', async () => {
        process.argv.push('--owner', 'Expensify', '--repo', 'Auth', '--pull-request-number', '21136', '--target-branch', 'main', '--actor-type', 'User', '--head-sha', 'not-a-sha');
        await assert.rejects(() => VerifyPeerReview.main(client), /exit 1/);
    });

    it('rejects a workflow event whose head no longer matches the PR', async () => {
        process.argv.push('--owner', 'Expensify', '--repo', 'Auth', '--pull-request-number', '21136', '--target-branch', 'main', '--actor-type', 'User', '--head-sha', 'b'.repeat(40));
        await assert.rejects(() => VerifyPeerReview.main(client), /no longer has the expected head/);
    });
});
