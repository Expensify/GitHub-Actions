import assert from 'node:assert/strict';
import {afterEach, beforeEach, describe, it} from 'node:test';
import VerifyPeerReview from '../scripts/verifyPeerReview';

const ORIGINAL_ARGV = process.argv;

describe('getPullRequestContext', () => {
    let originalExit: typeof process.exit;

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

    it('parses required pull request CLI arguments', () => {
        process.argv.push('--owner', 'Expensify', '--repo', 'Auth', '--number', '21136', '--base-ref', 'main');

        assert.deepEqual(VerifyPeerReview.getPullRequestContext(), {
            owner: 'Expensify',
            repo: 'Auth',
            number: 21136,
            baseRef: 'main',
        });
    });

    it('fails when required arguments are missing', () => {
        assert.throws(() => VerifyPeerReview.getPullRequestContext(), /exit 1/);
    });
});
