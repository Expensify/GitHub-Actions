import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import type {GitHubPullRequestCommit} from '../scripts/libs/GitCommitUtils';
import type {GitHubUtils} from '../scripts/libs/GitHubUtils';
import VerifyPeerReview from '../scripts/verifyPeerReview';
import createFakeGitHubUtils from './createFakeGitHubUtils';

const COMMIT_SHA = '11cfd67d458e0d97bd22d637aea32534d9666f12';

function makeCommit(authorLogin: string | undefined, authorName: string | undefined, message: string): GitHubPullRequestCommit {
    return {
        sha: COMMIT_SHA,
        author: authorLogin ? {login: authorLogin} : null,
        commit: {
            message,
            author: authorName ? {name: authorName} : {},
        },
    };
}

function fakeGitHubUtilsWithCommits(commits: GitHubPullRequestCommit[], overrides: Partial<GitHubUtils> = {}): GitHubUtils {
    return createFakeGitHubUtils({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrow test fixture standing in for the full Octokit commit type
        listPullRequestCommits: async () => commits as unknown as Awaited<ReturnType<GitHubUtils['listPullRequestCommits']>>,
        ...overrides,
    });
}

const BASE_ARGS = {owner: 'Expensify', repo: 'Auth', prNumber: 21136, actorType: 'User' as const};

describe('getCommitAuthors', () => {
    it('counts co-authors for bot-authored commits', async () => {
        const gitHubUtils = fakeGitHubUtilsWithCommits([makeCommit('MelvinBot', undefined, 'Change\n\nCo-authored-by: Andrew Gable <AndrewGable@users.noreply.github.com>')]);

        const result = await VerifyPeerReview.getCommitAuthors(gitHubUtils, BASE_ARGS);

        assert.deepEqual(result.at(0), 'AndrewGable');
        assert.ok(result.includes('MelvinBot'));
    });

    it('ignores co-authors when canonical author is human', async () => {
        const gitHubUtils = fakeGitHubUtilsWithCommits([makeCommit('rafecolton', undefined, 'Change\n\nCo-authored-by: Andrew Gable <AndrewGable@users.noreply.github.com>')]);

        const result = await VerifyPeerReview.getCommitAuthors(gitHubUtils, BASE_ARGS);

        assert.deepEqual(result.at(0), 'rafecolton');
    });

    it('falls back to commit author name when github login is missing', async () => {
        const gitHubUtils = fakeGitHubUtilsWithCommits([makeCommit(undefined, 'AndrewGable', 'Change')]);

        const result = await VerifyPeerReview.getCommitAuthors(gitHubUtils, BASE_ARGS);

        assert.deepEqual(result.at(0), 'AndrewGable');
    });

    it('does not look up commit authors when every co-author uses a noreply address', async () => {
        const gitHubUtils = fakeGitHubUtilsWithCommits([makeCommit('MelvinBot', undefined, 'Change\n\nCo-authored-by: Andrew Gable <AndrewGable@users.noreply.github.com>')], {
            getCommitAuthorLoginsByEmail: async () => {
                throw new Error('getCommitAuthorLoginsByEmail should not be called');
            },
        });

        const result = await VerifyPeerReview.getCommitAuthors(gitHubUtils, BASE_ARGS);

        assert.deepEqual(result, ['AndrewGable', 'MelvinBot']);
    });

    it('resolves non-noreply co-author emails through GitHub commit authors', async () => {
        const lookups: Array<{owner: string; repo: string; sha: string}> = [];
        const gitHubUtils = fakeGitHubUtilsWithCommits(
            [makeCommit('MelvinBot', undefined, 'Change\n\nCo-authored-by: RachCHopkins <rachael@expensify.com>\nCo-authored-by: Rachael Hopkins <RachCHopkins@users.noreply.github.com>')],
            {
                getCommitAuthorLoginsByEmail: async (args) => {
                    lookups.push(args);
                    return new Map([['rachael@expensify.com', 'RachCHopkins']]);
                },
            },
        );

        const result = await VerifyPeerReview.getCommitAuthors(gitHubUtils, BASE_ARGS);

        assert.deepEqual(result, ['MelvinBot', 'RachCHopkins']);
        assert.deepEqual(lookups, [{owner: BASE_ARGS.owner, repo: BASE_ARGS.repo, sha: COMMIT_SHA}]);
    });

    it('matches non-noreply co-author emails case-insensitively', async () => {
        const gitHubUtils = fakeGitHubUtilsWithCommits([makeCommit('MelvinBot', undefined, 'Change\n\nCo-authored-by: John Smith <  Andrew@Expensify.com  >')], {
            getCommitAuthorLoginsByEmail: async () => new Map([['andrew@expensify.com', 'AndrewGable']]),
        });

        const result = await VerifyPeerReview.getCommitAuthors(gitHubUtils, BASE_ARGS);

        assert.deepEqual(result, ['AndrewGable', 'MelvinBot']);
    });

    it('throws when GitHub does not match a non-noreply co-author email to a user', async () => {
        const gitHubUtils = fakeGitHubUtilsWithCommits([makeCommit('MelvinBot', undefined, 'Change\n\nCo-authored-by: John Smith <andrew@expensify.com>')], {
            getCommitAuthorLoginsByEmail: async () => new Map([['infra+melvinbot@expensify.com', 'MelvinBot']]),
        });

        await assert.rejects(() => VerifyPeerReview.getCommitAuthors(gitHubUtils, BASE_ARGS), /Unable to resolve co-author email to GitHub user: andrew@expensify.com/);
    });

    it('throws when GitHub lists no user for any co-author email', async () => {
        const gitHubUtils = fakeGitHubUtilsWithCommits([makeCommit('MelvinBot', undefined, 'Change\n\nCo-authored-by: Jane Doe <jane.doe@gmail.com>')]);

        await assert.rejects(() => VerifyPeerReview.getCommitAuthors(gitHubUtils, BASE_ARGS), /Unable to resolve co-author email/);
    });

    it('throws when canonical author cannot be resolved', async () => {
        const gitHubUtils = fakeGitHubUtilsWithCommits([makeCommit(undefined, undefined, 'Change')]);

        await assert.rejects(() => VerifyPeerReview.getCommitAuthors(gitHubUtils, BASE_ARGS), /Unable to resolve canonical commit author/);
    });
});
