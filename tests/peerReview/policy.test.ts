import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import Policy from '../../scripts/libs/peerReview/policy';
import type {PeerReviewInput} from '../../scripts/libs/peerReview/types';

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
        const independent = Policy.getIndependentEmployeeApprovers(['AndrewGable', 'MonilBhavsar', 'externalCollab'], ['AndrewGable'], new Set(['AndrewGable', 'MonilBhavsar']));

        assert.deepEqual(independent, ['MonilBhavsar']);
    });
});

describe('evaluatePeerReview', () => {
    it('skips when branch requires no approving reviews', () => {
        const result = Policy.evaluatePeerReview({
            ...baseInput,
            requiredApprovingReviewCount: 0,
            approvers: ['AndrewGable'],
            authors: ['AndrewGable'],
        });

        assert.equal(result.status, 'skip');
    });

    it('skips when there are no approving reviews yet', () => {
        const result = Policy.evaluatePeerReview({
            ...baseInput,
            approvers: [],
            authors: ['MelvinBot', 'AndrewGable'],
        });

        assert.equal(result.status, 'skip');
    });

    it('fails on self-review from commit co-author', () => {
        const result = Policy.evaluatePeerReview({
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
        const result = Policy.evaluatePeerReview({
            ...baseInput,
            approvers: ['MonilBhavsar', 'AndrewGable'],
            authors: ['MelvinBot', 'AndrewGable'],
        });

        assert.equal(result.status, 'pass');
    });

    it('fails when independent approver count is below required', () => {
        const result = Policy.evaluatePeerReview({
            ...baseInput,
            requiredApprovingReviewCount: 2,
            approvers: ['MonilBhavsar', 'AndrewGable'],
            authors: ['MelvinBot', 'AndrewGable'],
        });

        assert.equal(result.status, 'fail');
    });

    it('passes when independent approver count meets required', () => {
        const result = Policy.evaluatePeerReview({
            ...baseInput,
            requiredApprovingReviewCount: 2,
            approvers: ['MonilBhavsar', 'rafecolton'],
            authors: ['MelvinBot', 'AndrewGable'],
        });

        assert.equal(result.status, 'pass');
    });

    it('fails when all authors are bots', () => {
        const result = Policy.evaluatePeerReview({
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
        const result = Policy.evaluatePeerReview({
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
