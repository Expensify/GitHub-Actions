import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import type {GitHubPullRequestCommit} from '../scripts/libs/GitCommitUtils';
import type {GitHubUtils} from '../scripts/libs/GitHubUtils';
import {WorkflowError} from '../scripts/libs/GitHubWorkflowUtils';
import VerifyPeerReview, {type PeerReviewInput} from '../scripts/verifyPeerReview';
import createFakeGitHubUtils from './createFakeGitHubUtils';

function makeCommit(login: string, message = ''): GitHubPullRequestCommit {
    return {author: {login}, commit: {message}};
}

function mockCommits(commits: GitHubPullRequestCommit[]): GitHubUtils['listPullRequestCommits'] {
    // Tests only need the GitHubPullRequestCommit fields consumed by getCommitAuthors, not the full Octokit response shape.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrow test fixture standing in for the full Octokit commit type
    return async () => commits as unknown as Awaited<ReturnType<GitHubUtils['listPullRequestCommits']>>;
}

const BASE_INPUT: PeerReviewInput = {
    owner: 'Expensify',
    repo: 'Auth',
    prNumber: 21136,
    targetBranch: 'main',
    actorType: 'User',
};

describe('verifyPeerReview', () => {
    describe('getIndependentEmployeeApprovers', () => {
        it('excludes commit authors and non-employees', async () => {
            const gitHubUtils = createFakeGitHubUtils({isExpensifyEmployee: async (login) => new Set(['AndrewGable', 'MonilBhavsar']).has(login)});

            const independent = await VerifyPeerReview.getIndependentEmployeeApprovers(gitHubUtils, ['AndrewGable', 'MonilBhavsar'], ['AndrewGable']);

            assert.deepEqual(independent, ['MonilBhavsar']);
        });

        it('does not match employee logins with different casing', async () => {
            // GitHub logins are case-sensitive, and both approvers and employee logins come directly from
            // GitHub's API, so a real match is never case-mismatched. Folding case here would be incorrect.
            const gitHubUtils = createFakeGitHubUtils({isExpensifyEmployee: async (login) => new Set(['MonilBhavsar']).has(login)});

            const independent = await VerifyPeerReview.getIndependentEmployeeApprovers(gitHubUtils, ['monilbhavsar'], ['AndrewGable']);

            assert.deepEqual(independent, []);
        });

        it('does not treat an approver as a commit-author match when casing differs', async () => {
            // Same reasoning as above: a real commit author and a real approver are never the same
            // account with different casing, so this must not be a case-insensitive comparison.
            const gitHubUtils = createFakeGitHubUtils({isExpensifyEmployee: async (login) => new Set(['andrewgable']).has(login)});

            const independent = await VerifyPeerReview.getIndependentEmployeeApprovers(gitHubUtils, ['andrewgable'], ['AndrewGable']);

            assert.deepEqual(independent, ['andrewgable']);
        });
    });

    describe('evaluatePeerReview', () => {
        function createBaseFakeGitHubUtils(overrides: Partial<GitHubUtils> = {}): GitHubUtils {
            return createFakeGitHubUtils({
                getRequiredApprovingReviewCount: async () => 1,
                getLatestApprovers: async () => [],
                listPullRequestCommits: async () => [],
                isExpensifyEmployee: async (login) => new Set(['MonilBhavsar', 'AndrewGable', 'rafecolton']).has(login),
                ...overrides,
            });
        }

        it('passes when branch requires no approving reviews', async () => {
            const gitHubUtils = createBaseFakeGitHubUtils({getRequiredApprovingReviewCount: async () => 0});

            const result = await VerifyPeerReview.evaluatePeerReview(gitHubUtils, BASE_INPUT);

            assert.equal(result.status, 'pass');
        });

        it('fails when the pull request has more than 250 commits', async () => {
            const gitHubUtils = createBaseFakeGitHubUtils({getPullRequestCommitCount: async () => 251});

            const result = await VerifyPeerReview.evaluatePeerReview(gitHubUtils, BASE_INPUT);

            assert.equal(result.status, 'fail');
            if (result.status === 'fail') {
                assert.match(result.error.message, /has 251 commits, which exceeds the 250-commit limit/);
                assert.ok(result.error instanceof WorkflowError);
                assert.equal(result.error.title, 'Too many commits to verify');
            }
        });

        it('passes with exactly 250 commits when otherwise eligible', async () => {
            const gitHubUtils = createBaseFakeGitHubUtils({
                getPullRequestCommitCount: async () => 250,
                getLatestApprovers: async () => ['MonilBhavsar'],
                listPullRequestCommits: mockCommits([makeCommit('AndrewGable')]),
            });

            const result = await VerifyPeerReview.evaluatePeerReview(gitHubUtils, BASE_INPUT);

            assert.equal(result.status, 'pass');
        });

        it('fails when no commit authors can be determined', async () => {
            const gitHubUtils = createBaseFakeGitHubUtils({listPullRequestCommits: mockCommits([])});

            const result = await VerifyPeerReview.evaluatePeerReview(gitHubUtils, BASE_INPUT);

            assert.equal(result.status, 'fail');
            if (result.status === 'fail') {
                assert.match(result.error.message, /Unable to determine any commit authors/);
                assert.ok(result.error instanceof WorkflowError);
                assert.equal(result.error.title, 'No commit authors found');
            }
        });

        it('fails when there are no approving reviews yet', async () => {
            const gitHubUtils = createBaseFakeGitHubUtils({listPullRequestCommits: mockCommits([makeCommit('MelvinBot'), makeCommit('AndrewGable')])});

            const result = await VerifyPeerReview.evaluatePeerReview(gitHubUtils, BASE_INPUT);

            assert.equal(result.status, 'fail');
            if (result.status === 'fail') {
                assert.match(result.error.message, /does not have enough independent Expensify employee approvals/);
                assert.ok(result.error instanceof WorkflowError);
                assert.equal(result.error.title, 'Missing independent peer review');
            }
        });

        it('fails on self-review from commit co-author', async () => {
            const gitHubUtils = createBaseFakeGitHubUtils({
                getLatestApprovers: async () => ['AndrewGable'],
                listPullRequestCommits: mockCommits([makeCommit('MelvinBot'), makeCommit('AndrewGable')]),
            });

            const result = await VerifyPeerReview.evaluatePeerReview(gitHubUtils, BASE_INPUT);

            assert.equal(result.status, 'fail');
            if (result.status === 'fail') {
                assert.match(result.error.message, /does not have enough independent Expensify employee approvals/);
            }
        });

        it('passes when an independent employee approves', async () => {
            const gitHubUtils = createBaseFakeGitHubUtils({
                getLatestApprovers: async () => ['MonilBhavsar', 'AndrewGable'],
                listPullRequestCommits: mockCommits([makeCommit('MelvinBot'), makeCommit('AndrewGable')]),
            });

            const result = await VerifyPeerReview.evaluatePeerReview(gitHubUtils, BASE_INPUT);

            assert.equal(result.status, 'pass');
        });

        it('fails when independent approver count is below required', async () => {
            const gitHubUtils = createBaseFakeGitHubUtils({
                getRequiredApprovingReviewCount: async () => 2,
                getLatestApprovers: async () => ['MonilBhavsar', 'AndrewGable'],
                listPullRequestCommits: mockCommits([makeCommit('MelvinBot'), makeCommit('AndrewGable')]),
            });

            const result = await VerifyPeerReview.evaluatePeerReview(gitHubUtils, BASE_INPUT);

            assert.equal(result.status, 'fail');
        });

        it('passes when independent approver count meets required', async () => {
            const gitHubUtils = createBaseFakeGitHubUtils({
                getRequiredApprovingReviewCount: async () => 2,
                getLatestApprovers: async () => ['MonilBhavsar', 'rafecolton'],
                listPullRequestCommits: mockCommits([makeCommit('MelvinBot'), makeCommit('AndrewGable')]),
            });

            const result = await VerifyPeerReview.evaluatePeerReview(gitHubUtils, BASE_INPUT);

            assert.equal(result.status, 'pass');
        });

        it('fails when all authors are bots and only one independent approver exists', async () => {
            // requiredApprovingReviewCount is 1 (from createBaseFakeGitHubUtils), but a bot-only author list
            // requires two independent approvers so a single reviewer can't rubber-stamp a bypass.
            const gitHubUtils = createBaseFakeGitHubUtils({
                getLatestApprovers: async () => ['AndrewGable'],
                listPullRequestCommits: mockCommits([makeCommit('MelvinBot')]),
            });

            const result = await VerifyPeerReview.evaluatePeerReview(gitHubUtils, BASE_INPUT);

            assert.equal(result.status, 'fail');
            if (result.status === 'fail') {
                assert.match(
                    result.error.message,
                    /does not have enough independent Expensify employee approvals\. Pull requests authored solely by bots require a minimum of 2 independent Expensify employee approvals\./,
                );
            }
        });

        it('passes when all authors are bots and two independent approvers exist', async () => {
            const gitHubUtils = createBaseFakeGitHubUtils({
                getLatestApprovers: async () => ['AndrewGable', 'MonilBhavsar'],
                listPullRequestCommits: mockCommits([makeCommit('MelvinBot')]),
            });

            const result = await VerifyPeerReview.evaluatePeerReview(gitHubUtils, BASE_INPUT);

            assert.equal(result.status, 'pass');
        });

        it('fails on unresolved co-author emails', async () => {
            const gitHubUtils = createBaseFakeGitHubUtils({
                getLatestApprovers: async () => ['AndrewGable'],
                listPullRequestCommits: mockCommits([makeCommit('MelvinBot', 'Change\n\nCo-authored-by: John Smith <andrew@expensify.com>')]),
            });

            await assert.rejects(
                () => VerifyPeerReview.evaluatePeerReview(gitHubUtils, BASE_INPUT),
                (error: unknown) => {
                    assert.ok(error instanceof WorkflowError);
                    assert.match(error.message, /Unable to resolve co-author email/);
                    assert.equal(error.title, 'Unresolved co-author');
                    return true;
                },
            );
        });

        it('fails on unresolved co-author emails regardless of domain', async () => {
            const gitHubUtils = createBaseFakeGitHubUtils({
                getLatestApprovers: async () => ['AndrewGable'],
                listPullRequestCommits: mockCommits([makeCommit('MelvinBot', 'Change\n\nCo-authored-by: Jane Doe <jane.doe@gmail.com>')]),
            });

            await assert.rejects(() => VerifyPeerReview.evaluatePeerReview(gitHubUtils, BASE_INPUT), /Unable to resolve co-author email/);
        });
    });
});
