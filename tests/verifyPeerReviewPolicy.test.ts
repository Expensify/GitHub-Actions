import assert from 'node:assert/strict';
import {afterEach, beforeEach, describe, it} from 'node:test';

import type {GitHubPullRequestCommit} from '../scripts/libs/GitCommitUtils';
import GitHubUtils from '../scripts/libs/GitHubUtils';
import VerifyPeerReview, {type PeerReviewInput} from '../scripts/verifyPeerReview';

function makeCommit(login: string, message = ''): GitHubPullRequestCommit {
    return {author: {login}, commit: {message}};
}

function mockCommits(commits: GitHubPullRequestCommit[]): typeof GitHubUtils.listPullRequestCommits {
    // Tests only need the GitHubPullRequestCommit fields consumed by getCommitAuthors, not the full Octokit response shape.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrow test fixture standing in for the full Octokit commit type
    return async () => commits as unknown as Awaited<ReturnType<typeof GitHubUtils.listPullRequestCommits>>;
}

const BASE_INPUT: PeerReviewInput = {
    owner: 'Expensify',
    repo: 'Auth',
    prNumber: 21136,
    targetBranch: 'main',
};

describe('getIndependentEmployeeApprovers', () => {
    let originalIsExpensifyEmployee: typeof GitHubUtils.isExpensifyEmployee;

    beforeEach(() => {
        originalIsExpensifyEmployee = GitHubUtils.isExpensifyEmployee;
    });

    afterEach(() => {
        GitHubUtils.isExpensifyEmployee = originalIsExpensifyEmployee;
    });

    it('excludes commit authors and non-employees', async () => {
        GitHubUtils.isExpensifyEmployee = async (login) => new Set(['AndrewGable', 'MonilBhavsar']).has(login);

        const independent = await VerifyPeerReview.getIndependentEmployeeApprovers(['AndrewGable', 'MonilBhavsar', 'externalCollab'], ['AndrewGable']);

        assert.deepEqual(independent, ['MonilBhavsar']);
    });

    it('does not match employee logins with different casing', async () => {
        // GitHub logins are case-sensitive, and both approvers and employee logins come directly from
        // GitHub's API, so a real match is never case-mismatched. Folding case here would be incorrect.
        GitHubUtils.isExpensifyEmployee = async (login) => new Set(['MonilBhavsar']).has(login);

        const independent = await VerifyPeerReview.getIndependentEmployeeApprovers(['monilbhavsar'], ['AndrewGable']);

        assert.deepEqual(independent, []);
    });

    it('does not treat an approver as a commit-author match when casing differs', async () => {
        // Same reasoning as above: a real commit author and a real approver are never the same
        // account with different casing, so this must not be a case-insensitive comparison.
        GitHubUtils.isExpensifyEmployee = async (login) => new Set(['andrewgable']).has(login);

        const independent = await VerifyPeerReview.getIndependentEmployeeApprovers(['andrewgable'], ['AndrewGable']);

        assert.deepEqual(independent, ['andrewgable']);
    });
});

describe('evaluatePeerReview', () => {
    let originalGetRequiredApprovingReviewCount: typeof GitHubUtils.getRequiredApprovingReviewCount;
    let originalGetLatestApprovers: typeof GitHubUtils.getLatestApprovers;
    let originalListPullRequestCommits: typeof GitHubUtils.listPullRequestCommits;
    let originalIsExpensifyEmployee: typeof GitHubUtils.isExpensifyEmployee;

    beforeEach(() => {
        originalGetRequiredApprovingReviewCount = GitHubUtils.getRequiredApprovingReviewCount;
        originalGetLatestApprovers = GitHubUtils.getLatestApprovers;
        originalListPullRequestCommits = GitHubUtils.listPullRequestCommits;
        originalIsExpensifyEmployee = GitHubUtils.isExpensifyEmployee;

        GitHubUtils.getRequiredApprovingReviewCount = async () => 1;
        GitHubUtils.getLatestApprovers = async () => [];
        GitHubUtils.listPullRequestCommits = async () => [];
        GitHubUtils.isExpensifyEmployee = async (login) => new Set(['MonilBhavsar', 'AndrewGable', 'rafecolton']).has(login);
    });

    afterEach(() => {
        GitHubUtils.getRequiredApprovingReviewCount = originalGetRequiredApprovingReviewCount;
        GitHubUtils.getLatestApprovers = originalGetLatestApprovers;
        GitHubUtils.listPullRequestCommits = originalListPullRequestCommits;
        GitHubUtils.isExpensifyEmployee = originalIsExpensifyEmployee;
    });

    it('skips when branch requires no approving reviews', async () => {
        GitHubUtils.getRequiredApprovingReviewCount = async () => 0;

        const result = await VerifyPeerReview.evaluatePeerReview(BASE_INPUT);

        assert.equal(result.status, 'skip');
    });

    it('fails when no commit authors can be determined', async () => {
        GitHubUtils.listPullRequestCommits = mockCommits([]);

        const result = await VerifyPeerReview.evaluatePeerReview(BASE_INPUT);

        assert.equal(result.status, 'fail');
        if (result.status === 'fail') {
            assert.match(result.error.message, /Unable to determine any commit authors/);
        }
    });

    it('fails when there are no approving reviews yet', async () => {
        GitHubUtils.listPullRequestCommits = mockCommits([makeCommit('MelvinBot'), makeCommit('AndrewGable')]);

        const result = await VerifyPeerReview.evaluatePeerReview(BASE_INPUT);

        assert.equal(result.status, 'fail');
        if (result.status === 'fail') {
            assert.match(result.error.message, /does not have enough independent Expensify employee approvals/);
        }
    });

    it('fails on self-review from commit co-author', async () => {
        GitHubUtils.getLatestApprovers = async () => ['AndrewGable'];
        GitHubUtils.listPullRequestCommits = mockCommits([makeCommit('MelvinBot'), makeCommit('AndrewGable')]);

        const result = await VerifyPeerReview.evaluatePeerReview(BASE_INPUT);

        assert.equal(result.status, 'fail');
        if (result.status === 'fail') {
            assert.match(result.error.message, /does not have enough independent Expensify employee approvals/);
        }
    });

    it('passes when an independent employee approves', async () => {
        GitHubUtils.getLatestApprovers = async () => ['MonilBhavsar', 'AndrewGable'];
        GitHubUtils.listPullRequestCommits = mockCommits([makeCommit('MelvinBot'), makeCommit('AndrewGable')]);

        const result = await VerifyPeerReview.evaluatePeerReview(BASE_INPUT);

        assert.equal(result.status, 'pass');
    });

    it('fails when independent approver count is below required', async () => {
        GitHubUtils.getRequiredApprovingReviewCount = async () => 2;
        GitHubUtils.getLatestApprovers = async () => ['MonilBhavsar', 'AndrewGable'];
        GitHubUtils.listPullRequestCommits = mockCommits([makeCommit('MelvinBot'), makeCommit('AndrewGable')]);

        const result = await VerifyPeerReview.evaluatePeerReview(BASE_INPUT);

        assert.equal(result.status, 'fail');
    });

    it('passes when independent approver count meets required', async () => {
        GitHubUtils.getRequiredApprovingReviewCount = async () => 2;
        GitHubUtils.getLatestApprovers = async () => ['MonilBhavsar', 'rafecolton'];
        GitHubUtils.listPullRequestCommits = mockCommits([makeCommit('MelvinBot'), makeCommit('AndrewGable')]);

        const result = await VerifyPeerReview.evaluatePeerReview(BASE_INPUT);

        assert.equal(result.status, 'pass');
    });

    it('fails when all authors are bots', async () => {
        GitHubUtils.getLatestApprovers = async () => ['AndrewGable'];
        GitHubUtils.listPullRequestCommits = mockCommits([makeCommit('MelvinBot')]);

        const result = await VerifyPeerReview.evaluatePeerReview(BASE_INPUT);

        assert.equal(result.status, 'fail');
        if (result.status === 'fail') {
            assert.match(result.error.message, /All commit authors are bots/);
        }
    });

    it('fails on unresolved co-author emails', async () => {
        GitHubUtils.getLatestApprovers = async () => ['AndrewGable'];
        GitHubUtils.listPullRequestCommits = mockCommits([makeCommit('MelvinBot', 'Change\n\nCo-authored-by: John Smith <andrew@expensify.com>')]);

        const result = await VerifyPeerReview.evaluatePeerReview(BASE_INPUT);

        assert.equal(result.status, 'fail');
        if (result.status === 'fail') {
            assert.match(result.error.message, /Unable to resolve co-author emails/);
        }
    });

    it('fails on unresolved co-author emails regardless of domain', async () => {
        GitHubUtils.getLatestApprovers = async () => ['AndrewGable'];
        GitHubUtils.listPullRequestCommits = mockCommits([makeCommit('MelvinBot', 'Change\n\nCo-authored-by: Jane Doe <jane.doe@gmail.com>')]);

        const result = await VerifyPeerReview.evaluatePeerReview(BASE_INPUT);

        assert.equal(result.status, 'fail');
        if (result.status === 'fail') {
            assert.match(result.error.message, /Unable to resolve co-author emails/);
        }
    });
});

describe('getFailureTitle', () => {
    it('maps failure titles for known messages', () => {
        assert.equal(VerifyPeerReview.getFailureTitle('Unable to resolve canonical commit author: missing GitHub author login and commit author name.'), 'Missing commit author');
        assert.equal(VerifyPeerReview.getFailureTitle('Unable to determine any commit authors for Expensify/Auth#1.'), 'No commit authors found');
        assert.equal(VerifyPeerReview.getFailureTitle('Unable to resolve co-author emails to GitHub users: jane.doe@gmail.com'), 'Unresolved co-author');
        assert.equal(VerifyPeerReview.getFailureTitle('All commit authors are bots'), 'No human commit author');
        assert.equal(VerifyPeerReview.getFailureTitle('Expensify/Auth#1 does not have enough independent Expensify employee approvals.'), 'Missing independent peer review');
        assert.equal(VerifyPeerReview.getFailureTitle('Unable to read branch protection rules for Expensify/Auth@main.'), 'Branch protection lookup failed');
    });
});
