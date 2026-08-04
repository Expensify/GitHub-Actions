import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import type {GitHubPullRequestCommit} from '../scripts/libs/GitCommitUtils';
import type {GitHubUtils} from '../scripts/libs/GitHubUtils';
import VerifyPeerReview from '../scripts/verifyPeerReview';
import createFakeGitHubUtils from './createFakeGitHubUtils';

function makeCommit(authorLogin: string | undefined, authorName: string | undefined, message: string): GitHubPullRequestCommit {
    return {
        author: authorLogin ? {login: authorLogin} : null,
        commit: {
            message,
            author: authorName ? {name: authorName} : {},
        },
    };
}

function fakeGitHubUtilsWithCommits(commits: GitHubPullRequestCommit[]): GitHubUtils {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrow test fixture standing in for the full Octokit commit type
    return createFakeGitHubUtils({listPullRequestCommits: async () => commits as unknown as Awaited<ReturnType<GitHubUtils['listPullRequestCommits']>>});
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

    it('throws when co-author email cannot be resolved (unresolved detection)', async () => {
        const gitHubUtils = fakeGitHubUtilsWithCommits([makeCommit('MelvinBot', undefined, 'Change\n\nCo-authored-by: John Smith <  Andrew@Expensify.com  >')]);

        await assert.rejects(() => VerifyPeerReview.getCommitAuthors(gitHubUtils, BASE_ARGS), /Unable to resolve co-author email/);
    });

    it('throws when resolving non-noreply co-author addresses', async () => {
        const gitHubUtils = fakeGitHubUtilsWithCommits([makeCommit('MelvinBot', undefined, 'Change\n\nCo-authored-by: John Smith <andrew@expensify.com>')]);

        await assert.rejects(() => VerifyPeerReview.getCommitAuthors(gitHubUtils, BASE_ARGS), /Unable to resolve co-author email/);
    });

    it('throws when resolving any unresolvable co-author domain', async () => {
        const gitHubUtils = fakeGitHubUtilsWithCommits([makeCommit('MelvinBot', undefined, 'Change\n\nCo-authored-by: Jane Doe <jane.doe@gmail.com>')]);

        await assert.rejects(() => VerifyPeerReview.getCommitAuthors(gitHubUtils, BASE_ARGS), /Unable to resolve co-author email/);
    });

    it('throws when canonical author cannot be resolved', async () => {
        const gitHubUtils = fakeGitHubUtilsWithCommits([makeCommit(undefined, undefined, 'Change')]);

        await assert.rejects(() => VerifyPeerReview.getCommitAuthors(gitHubUtils, BASE_ARGS), /Unable to resolve canonical commit author/);
    });
});
