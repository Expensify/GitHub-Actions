import assert from 'node:assert/strict';
import {afterEach, beforeEach, describe, it} from 'node:test';

import VerifyPeerReview from '../scripts/verifyPeerReview';
import createFakeGitHubUtils from './createFakeGitHubUtils';

const ORIGINAL_ARGV = process.argv;

describe('main CLI parsing', () => {
    let originalExit: typeof process.exit;
    const fakeGitHubUtils = createFakeGitHubUtils({getRequiredApprovingReviewCount: async () => 0});

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
        process.argv.push('--owner', 'Expensify', '--repo', 'Auth', '--pull-request-number', '21136', '--target-branch', 'main', '--actor-type', 'User');

        await assert.doesNotReject(() => VerifyPeerReview.main(fakeGitHubUtils));
    });

    it('fails when required arguments are missing', async () => {
        await assert.rejects(() => VerifyPeerReview.main(fakeGitHubUtils), /exit 1/);
    });
});
