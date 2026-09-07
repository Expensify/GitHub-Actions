import {describe, it} from 'bun:test';
import assert from 'node:assert/strict';

import VerifyPeerReview from '../scripts/verifyPeerReview';
import createFakeGitHubUtils from './createFakeGitHubUtils';

const VALID_ARGS = ['--owner', 'Expensify', '--repo', 'Auth', '--pull-request-number', '21136', '--target-branch', 'main', '--actor-type', 'User'];

describe('main CLI parsing', () => {
    const fakeGitHubUtils = createFakeGitHubUtils({getRequiredApprovingReviewCount: async () => 0});

    it('parses required pull request CLI arguments', async () => {
        await assert.doesNotReject(() => VerifyPeerReview.main(fakeGitHubUtils, VALID_ARGS));
    });

    it('fails when required arguments are missing', async () => {
        await assert.rejects(() => VerifyPeerReview.main(fakeGitHubUtils, []), /Missing required CLI argument/);
    });

    it('fails when the pull request number is invalid', async () => {
        const args = [...VALID_ARGS];
        args[5] = 'invalid';
        await assert.rejects(() => VerifyPeerReview.main(fakeGitHubUtils, args), /must be a positive integer/);
    });

    it('fails when the actor type is invalid', async () => {
        const args = [...VALID_ARGS];
        args[9] = 'Organization';
        await assert.rejects(() => VerifyPeerReview.main(fakeGitHubUtils, args), /must be "Bot" or "User"/);
    });
});
