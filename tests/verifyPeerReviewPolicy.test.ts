import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import VerifyPeerReview, {type PeerReviewInput} from '../scripts/verifyPeerReview';

const baseInput: PeerReviewInput = {
    owner: 'Expensify',
    repo: 'Auth',
    number: 21136,
    baseRef: 'main',
    requiredApprovingReviewCount: 1,
    approvers: [],
    authors: [],
    unresolvedExpensifyCoAuthors: [],
    employeeLogins: new Set(['MonilBhavsar', 'AndrewGable', 'rafecolton']),
};

describe('getIndependentEmployeeApprovers', () => {
    it('excludes commit authors and non-employees', () => {
        const independent = VerifyPeerReview.getIndependentEmployeeApprovers(['AndrewGable', 'MonilBhavsar', 'externalCollab'], ['AndrewGable'], new Set(['AndrewGable', 'MonilBhavsar']));

        assert.deepEqual(independent, ['MonilBhavsar']);
    });

    it('matches employee logins case-insensitively', () => {
        const independent = VerifyPeerReview.getIndependentEmployeeApprovers(['monilbhavsar'], ['AndrewGable'], new Set(['MonilBhavsar']));

        assert.deepEqual(independent, ['MonilBhavsar']);
    });

    it('excludes commit authors case-insensitively', () => {
        const independent = VerifyPeerReview.getIndependentEmployeeApprovers(['andrewgable'], ['AndrewGable'], new Set(['AndrewGable']));

        assert.deepEqual(independent, []);
    });
});

describe('evaluatePeerReview', () => {
    it('skips when branch requires no approving reviews', () => {
        const result = VerifyPeerReview.evaluatePeerReview({
            ...baseInput,
            requiredApprovingReviewCount: 0,
            approvers: ['AndrewGable'],
            authors: ['AndrewGable'],
        });

        assert.equal(result.status, 'skip');
    });

    it('skips when there are no approving reviews yet', () => {
        const result = VerifyPeerReview.evaluatePeerReview({
            ...baseInput,
            approvers: [],
            authors: ['MelvinBot', 'AndrewGable'],
        });

        assert.equal(result.status, 'skip');
    });

    it('fails on self-review from commit co-author', () => {
        const result = VerifyPeerReview.evaluatePeerReview({
            ...baseInput,
            approvers: ['AndrewGable'],
            authors: ['MelvinBot', 'AndrewGable'],
        });

        assert.equal(result.status, 'fail');
        if (result.status === 'fail') {
            assert.match(result.error.message, /does not have enough independent Expensify employee approvals/);
        }
    });

    it('passes when an independent employee approves', () => {
        const result = VerifyPeerReview.evaluatePeerReview({
            ...baseInput,
            approvers: ['MonilBhavsar', 'AndrewGable'],
            authors: ['MelvinBot', 'AndrewGable'],
        });

        assert.equal(result.status, 'pass');
    });

    it('fails when independent approver count is below required', () => {
        const result = VerifyPeerReview.evaluatePeerReview({
            ...baseInput,
            requiredApprovingReviewCount: 2,
            approvers: ['MonilBhavsar', 'AndrewGable'],
            authors: ['MelvinBot', 'AndrewGable'],
        });

        assert.equal(result.status, 'fail');
    });

    it('passes when independent approver count meets required', () => {
        const result = VerifyPeerReview.evaluatePeerReview({
            ...baseInput,
            requiredApprovingReviewCount: 2,
            approvers: ['MonilBhavsar', 'rafecolton'],
            authors: ['MelvinBot', 'AndrewGable'],
        });

        assert.equal(result.status, 'pass');
    });

    it('fails when all authors are bots', () => {
        const result = VerifyPeerReview.evaluatePeerReview({
            ...baseInput,
            approvers: ['AndrewGable'],
            authors: ['MelvinBot'],
        });

        assert.equal(result.status, 'fail');
        if (result.status === 'fail') {
            assert.match(result.error.message, /no human commit authors or co-authors/);
        }
    });

    it('fails on unresolved expensify co-author emails', () => {
        const result = VerifyPeerReview.evaluatePeerReview({
            ...baseInput,
            approvers: ['AndrewGable'],
            authors: ['MelvinBot'],
            unresolvedExpensifyCoAuthors: ['andrew@expensify.com'],
        });

        assert.equal(result.status, 'fail');
        if (result.status === 'fail') {
            assert.match(result.error.message, /Unable to resolve Expensify co-author emails/);
        }
    });
});

describe('getFailureTitle', () => {
    it('maps failure titles for known messages', () => {
        assert.equal(VerifyPeerReview.getFailureTitle('Unable to resolve canonical commit author: missing GitHub author login and commit author name.'), 'Missing commit author');
        assert.equal(VerifyPeerReview.getFailureTitle('Expensify/Auth#1 does not have enough independent Expensify employee approvals.'), 'Missing independent peer review');
        assert.equal(VerifyPeerReview.getFailureTitle('Unable to read branch protection rules for Expensify/Auth@main.'), 'Branch protection lookup failed');
    });
});
