import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import type {GitHubUtils} from '../scripts/libs/GitHubUtils';
import {WorkflowError} from '../scripts/libs/GitHubWorkflowUtils';
import VerifyPeerReview, {type PeerReviewInput, type PeerReviewCommit, type PeerReviewData} from '../scripts/verifyPeerReview';
import createFakeGitHubUtils from './createFakeGitHubUtils';

function makeCommit(login: string, message = ''): PeerReviewCommit {
    return {sha: 'b26b3b2845725b0342443f5990801fe2d95bcf7d', author: {login}, commit: {message}, authorLoginsByEmail: new Map()};
}

const BASE_INPUT: PeerReviewInput = {
    owner: 'Expensify',
    repo: 'Auth',
    prNumber: 21136,
    targetBranch: 'main',
    actorType: 'User',
};

describe('verifyPeerReview', () => {
    describe('getIndependentApprovers', () => {
        it('looks up only independent approvers across all eligible teams in one call', async () => {
            let callCount = 0;
            let teamSlugs: string[] = [];
            let candidateLogins: string[] = [];
            const gitHubUtils = createFakeGitHubUtils({
                getTeamMemberLogins: async (teams, candidates) => {
                    callCount++;
                    teamSlugs = teams;
                    candidateLogins = candidates;
                    return new Set(['MonilBhavsar']);
                },
            });
            const independent = await VerifyPeerReview.getIndependentApprovers(
                gitHubUtils,
                ['AndrewGable', 'MonilBhavsar', 'outsider'],
                ['AndrewGable'],
                'Expensify',
                'react-native-live-markdown',
            );
            assert.deepEqual(independent, ['MonilBhavsar']);
            assert.equal(callCount, 1);
            assert.deepEqual(teamSlugs, ['expensify-expensify', 'react-native-live-markdown-writers', 'react-native-live-markdown-maintainers']);
            assert.deepEqual(candidateLogins, ['MonilBhavsar', 'outsider']);
        });

        it('excludes commit authors and non-employees', async () => {
            const gitHubUtils = createFakeGitHubUtils({getTeamMemberLogins: async () => new Set(['AndrewGable', 'MonilBhavsar'])});

            const independent = await VerifyPeerReview.getIndependentApprovers(gitHubUtils, ['AndrewGable', 'MonilBhavsar'], ['AndrewGable'], 'Expensify', 'Auth');

            assert.deepEqual(independent, ['MonilBhavsar']);
        });

        it('does not match employee logins with different casing', async () => {
            // GitHub logins are case-sensitive, and both approvers and employee logins come directly from
            // GitHub's API, so a real match is never case-mismatched. Folding case here would be incorrect.
            const gitHubUtils = createFakeGitHubUtils({getTeamMemberLogins: async () => new Set(['MonilBhavsar'])});

            const independent = await VerifyPeerReview.getIndependentApprovers(gitHubUtils, ['monilbhavsar'], ['AndrewGable'], 'Expensify', 'Auth');

            assert.deepEqual(independent, []);
        });

        it('does not treat an approver as a commit-author match when casing differs', async () => {
            // Same reasoning as above: a real commit author and a real approver are never the same
            // account with different casing, so this must not be a case-insensitive comparison.
            const gitHubUtils = createFakeGitHubUtils({getTeamMemberLogins: async () => new Set(['andrewgable'])});

            const independent = await VerifyPeerReview.getIndependentApprovers(gitHubUtils, ['andrewgable'], ['AndrewGable'], 'Expensify', 'Auth');

            assert.deepEqual(independent, ['andrewgable']);
        });
    });

    describe('evaluatePeerReview', () => {
        function createBaseFakeGitHubUtils(overrides: Partial<PeerReviewData> & Pick<Partial<GitHubUtils>, 'getTeamMemberLogins'> = {}): GitHubUtils & {data: PeerReviewData} {
            const {getTeamMemberLogins = async () => new Set(['MonilBhavsar', 'AndrewGable', 'rafecolton']), ...data} = overrides;
            return {
                ...createFakeGitHubUtils({getTeamMemberLogins}),
                data: {requiredApprovingReviewCount: 1, approvers: [], commits: [], commitCount: data.commits?.length ?? 0, ...data},
            };
        }

        function evaluatePeerReview(gitHubUtils: GitHubUtils & {data: PeerReviewData}, input: PeerReviewInput) {
            return VerifyPeerReview.evaluatePeerReview(gitHubUtils, input, gitHubUtils.data);
        }

        it('evaluates combined data without separate protection, count, commit, co-author, or approval calls', async () => {
            const unexpectedRead = async (): Promise<never> => {
                throw new Error('Unexpected separate API read');
            };
            const gitHubUtils = createFakeGitHubUtils({
                getRequiredApprovingReviewCount: unexpectedRead,
                getPullRequestCommitCount: unexpectedRead,
                listPullRequestCommits: unexpectedRead,
                getCommitAuthorLoginsByEmail: unexpectedRead,
                getLatestApprovers: unexpectedRead,
                getTeamMemberLogins: async () => new Set(['MonilBhavsar']),
            });
            const data = {requiredApprovingReviewCount: 1, commitCount: 1, commits: [makeCommit('AndrewGable')], approvers: ['MonilBhavsar']};
            assert.equal((await VerifyPeerReview.evaluatePeerReview(gitHubUtils, BASE_INPUT, data)).status, 'pass');
        });

        it('passes when branch requires no approving reviews', async () => {
            const gitHubUtils = createBaseFakeGitHubUtils({requiredApprovingReviewCount: 0});

            const result = await evaluatePeerReview(gitHubUtils, BASE_INPUT);

            assert.equal(result.status, 'pass');
        });

        it('passes with more than 250 commits when otherwise eligible', async () => {
            const gitHubUtils = createBaseFakeGitHubUtils({
                approvers: ['MonilBhavsar'],
                commits: Array.from({length: 350}, () => makeCommit('AndrewGable')),
            });

            const result = await evaluatePeerReview(gitHubUtils, BASE_INPUT);

            assert.equal(result.status, 'pass');
        });

        it('does not count approval from an author whose commit is beyond the first 250', async () => {
            const gitHubUtils = createBaseFakeGitHubUtils({
                approvers: ['MonilBhavsar'],
                commits: [...Array.from({length: 300}, () => makeCommit('AndrewGable')), makeCommit('MonilBhavsar')],
            });

            const result = await evaluatePeerReview(gitHubUtils, BASE_INPUT);

            assert.equal(result.status, 'fail');
            if (result.status === 'fail') {
                assert.ok(result.error instanceof WorkflowError);
                assert.equal(result.error.title, 'Missing independent peer review');
            }
        });

        it('fails when no commit authors can be determined', async () => {
            const gitHubUtils = createBaseFakeGitHubUtils({commits: []});

            const result = await evaluatePeerReview(gitHubUtils, BASE_INPUT);

            assert.equal(result.status, 'fail');
            if (result.status === 'fail') {
                assert.match(result.error.message, /Unable to determine any commit authors/);
                assert.ok(result.error instanceof WorkflowError);
                assert.equal(result.error.title, 'No commit authors found');
            }
        });

        it('fails when there are no approving reviews yet', async () => {
            const gitHubUtils = createBaseFakeGitHubUtils({commits: [makeCommit('MelvinBot'), makeCommit('AndrewGable')]});

            const result = await evaluatePeerReview(gitHubUtils, BASE_INPUT);

            assert.equal(result.status, 'fail');
            if (result.status === 'fail') {
                assert.match(result.error.message, /does not have enough independent eligible reviewer approvals/);
                assert.ok(result.error instanceof WorkflowError);
                assert.equal(result.error.title, 'Missing independent peer review');
            }
        });

        it('fails on self-review from commit co-author', async () => {
            const gitHubUtils = createBaseFakeGitHubUtils({
                approvers: ['AndrewGable'],
                commits: [makeCommit('MelvinBot'), makeCommit('AndrewGable')],
            });

            const result = await evaluatePeerReview(gitHubUtils, BASE_INPUT);

            assert.equal(result.status, 'fail');
            if (result.status === 'fail') {
                assert.match(result.error.message, /does not have enough independent eligible reviewer approvals/);
            }
        });

        it('does not count approval from a private-email co-author resolved in the combined read', async () => {
            const commit = makeCommit('MelvinBot', 'Change\n\nCo-authored-by: Andrew Gable <andrew@expensify.com>');
            commit.authorLoginsByEmail.set('andrew@expensify.com', 'AndrewGable');
            const gitHubUtils = createBaseFakeGitHubUtils({approvers: ['AndrewGable'], commits: [commit]});
            assert.equal((await evaluatePeerReview(gitHubUtils, BASE_INPUT)).status, 'fail');
        });

        it('passes when an independent employee approves', async () => {
            const gitHubUtils = createBaseFakeGitHubUtils({
                approvers: ['MonilBhavsar', 'AndrewGable'],
                commits: [makeCommit('MelvinBot'), makeCommit('AndrewGable')],
            });

            const result = await evaluatePeerReview(gitHubUtils, BASE_INPUT);

            assert.equal(result.status, 'pass');
        });

        it('passes when a Software Mansion maintainer approves a supported repository', async () => {
            const gitHubUtils = createBaseFakeGitHubUtils({
                approvers: ['JakubKorytko'],
                commits: [makeCommit('AndrewGable')],
                getTeamMemberLogins: async (teamSlugs) => {
                    assert.deepEqual(teamSlugs, ['expensify-expensify', 'react-native-wallet-writers']);
                    return new Set(['JakubKorytko']);
                },
            });

            const result = await evaluatePeerReview(gitHubUtils, {...BASE_INPUT, repo: 'react-native-wallet'});

            assert.equal(result.status, 'pass');
        });

        it('passes when an Expensify employee approves a supported repository without being on the repository-specific team', async () => {
            const gitHubUtils = createBaseFakeGitHubUtils({
                approvers: ['MonilBhavsar'],
                commits: [makeCommit('AndrewGable')],
                getTeamMemberLogins: async (teamSlugs) => {
                    assert.deepEqual(teamSlugs, ['expensify-expensify', 'react-native-wallet-writers']);
                    return new Set(['MonilBhavsar']);
                },
            });

            const result = await evaluatePeerReview(gitHubUtils, {...BASE_INPUT, repo: 'react-native-wallet'});

            assert.equal(result.status, 'pass');
        });

        it('does not count a Software Mansion maintainer for other repositories', async () => {
            const gitHubUtils = createBaseFakeGitHubUtils({
                approvers: ['JakubKorytko'],
                commits: [makeCommit('AndrewGable')],
                getTeamMemberLogins: async (teamSlugs) => {
                    assert.deepEqual(teamSlugs, ['expensify-expensify']);
                    return new Set(['MonilBhavsar', 'AndrewGable', 'rafecolton']);
                },
            });

            const result = await evaluatePeerReview(gitHubUtils, BASE_INPUT);

            assert.equal(result.status, 'fail');
        });

        it('fails when independent approver count is below required', async () => {
            const gitHubUtils = createBaseFakeGitHubUtils({
                requiredApprovingReviewCount: 2,
                approvers: ['MonilBhavsar', 'AndrewGable'],
                commits: [makeCommit('MelvinBot'), makeCommit('AndrewGable')],
            });

            const result = await evaluatePeerReview(gitHubUtils, BASE_INPUT);

            assert.equal(result.status, 'fail');
        });

        it('passes when independent approver count meets required', async () => {
            const gitHubUtils = createBaseFakeGitHubUtils({
                requiredApprovingReviewCount: 2,
                approvers: ['MonilBhavsar', 'rafecolton'],
                commits: [makeCommit('MelvinBot'), makeCommit('AndrewGable')],
            });

            const result = await evaluatePeerReview(gitHubUtils, BASE_INPUT);

            assert.equal(result.status, 'pass');
        });

        it('fails when all authors are bots and only one independent approver exists', async () => {
            // requiredApprovingReviewCount is 1 (from createBaseFakeGitHubUtils), but a bot-only author list
            // requires two independent approvers so a single reviewer can't rubber-stamp a bypass.
            const gitHubUtils = createBaseFakeGitHubUtils({
                approvers: ['AndrewGable'],
                commits: [makeCommit('MelvinBot')],
            });

            const result = await evaluatePeerReview(gitHubUtils, BASE_INPUT);

            assert.equal(result.status, 'fail');
            if (result.status === 'fail') {
                assert.match(
                    result.error.message,
                    /does not have enough independent eligible reviewer approvals\. Pull requests authored solely by bots require a minimum of 2 independent eligible reviewer approvals\./,
                );
            }
        });

        it('passes when all authors are bots and two independent approvers exist', async () => {
            const gitHubUtils = createBaseFakeGitHubUtils({
                approvers: ['AndrewGable', 'MonilBhavsar'],
                commits: [makeCommit('MelvinBot')],
            });

            const result = await evaluatePeerReview(gitHubUtils, BASE_INPUT);

            assert.equal(result.status, 'pass');
        });

        it('fails on unresolved co-author emails', async () => {
            const gitHubUtils = createBaseFakeGitHubUtils({
                approvers: ['AndrewGable'],
                commits: [makeCommit('MelvinBot', 'Change\n\nCo-authored-by: John Smith <andrew@expensify.com>')],
            });

            await assert.rejects(
                () => evaluatePeerReview(gitHubUtils, BASE_INPUT),
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
                approvers: ['AndrewGable'],
                commits: [makeCommit('MelvinBot', 'Change\n\nCo-authored-by: Jane Doe <jane.doe@gmail.com>')],
            });

            await assert.rejects(() => evaluatePeerReview(gitHubUtils, BASE_INPUT), /Unable to resolve co-author email/);
        });
    });
});
