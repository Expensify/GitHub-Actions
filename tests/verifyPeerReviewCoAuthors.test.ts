import assert from 'node:assert/strict';
import {afterEach, beforeEach, describe, it} from 'node:test';

import type {GitHubPullRequestCommit} from '../scripts/libs/GitCommitUtils';
import GitHubUtils from '../scripts/libs/GitHubUtils';
import VerifyPeerReview from '../scripts/verifyPeerReview';

function makeCommit(authorLogin: string | undefined, authorName: string | undefined, message: string): GitHubPullRequestCommit {
    return {
        author: authorLogin ? {login: authorLogin} : null,
        commit: {
            message,
            author: authorName ? {name: authorName} : {},
        },
    };
}

function mockCommits(commits: GitHubPullRequestCommit[]): typeof GitHubUtils.listPullRequestCommits {
    // Tests only need the GitHubPullRequestCommit fields consumed by getCommitAuthors, not the full Octokit response shape.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrow test fixture standing in for the full Octokit commit type
    return async () => commits as unknown as Awaited<ReturnType<typeof GitHubUtils.listPullRequestCommits>>;
}

const BASE_ARGS = {owner: 'Expensify', repo: 'Auth', prNumber: 21136};

describe('getCommitAuthors', () => {
    let originalListPullRequestCommits: typeof GitHubUtils.listPullRequestCommits;

    beforeEach(() => {
        originalListPullRequestCommits = GitHubUtils.listPullRequestCommits;
    });

    afterEach(() => {
        GitHubUtils.listPullRequestCommits = originalListPullRequestCommits;
    });

    it('counts co-authors for bot-authored commits', async () => {
        GitHubUtils.listPullRequestCommits = mockCommits([makeCommit('MelvinBot', undefined, 'Change\n\nCo-authored-by: Andrew Gable <AndrewGable@users.noreply.github.com>')]);

        const result = await VerifyPeerReview.getCommitAuthors(BASE_ARGS);

        assert.deepEqual(result.authors, ['AndrewGable', 'MelvinBot']);
        assert.deepEqual(result.unresolvedCoAuthors, []);
    });

    it('ignores co-authors when canonical author is human', async () => {
        GitHubUtils.listPullRequestCommits = mockCommits([makeCommit('rafecolton', undefined, 'Change\n\nCo-authored-by: Andrew Gable <AndrewGable@users.noreply.github.com>')]);

        const result = await VerifyPeerReview.getCommitAuthors(BASE_ARGS);

        assert.deepEqual(result.authors, ['rafecolton']);
    });

    it('falls back to commit author name when github login is missing', async () => {
        GitHubUtils.listPullRequestCommits = mockCommits([makeCommit(undefined, 'AndrewGable', 'Change')]);

        const result = await VerifyPeerReview.getCommitAuthors(BASE_ARGS);

        assert.deepEqual(result.authors, ['AndrewGable']);
    });

    it('normalizes co-author email casing and whitespace for unresolved detection', async () => {
        GitHubUtils.listPullRequestCommits = mockCommits([makeCommit('MelvinBot', undefined, 'Change\n\nCo-authored-by: John Smith <  Andrew@Expensify.com  >')]);

        const result = await VerifyPeerReview.getCommitAuthors(BASE_ARGS);

        assert.deepEqual(result.unresolvedCoAuthors, ['Andrew@Expensify.com']);
    });

    it('collects unresolved co-author emails for non-noreply addresses', async () => {
        GitHubUtils.listPullRequestCommits = mockCommits([makeCommit('MelvinBot', undefined, 'Change\n\nCo-authored-by: John Smith <andrew@expensify.com>')]);

        const result = await VerifyPeerReview.getCommitAuthors(BASE_ARGS);

        assert.deepEqual(result.unresolvedCoAuthors, ['andrew@expensify.com']);
    });

    it('collects unresolved co-author emails regardless of email domain', async () => {
        GitHubUtils.listPullRequestCommits = mockCommits([makeCommit('MelvinBot', undefined, 'Change\n\nCo-authored-by: Jane Doe <jane.doe@gmail.com>')]);

        const result = await VerifyPeerReview.getCommitAuthors(BASE_ARGS);

        assert.deepEqual(result.unresolvedCoAuthors, ['jane.doe@gmail.com']);
    });

    it('throws when canonical author cannot be resolved', async () => {
        GitHubUtils.listPullRequestCommits = mockCommits([makeCommit(undefined, undefined, 'Change')]);

        await assert.rejects(() => VerifyPeerReview.getCommitAuthors(BASE_ARGS), /Unable to resolve canonical commit author/);
    });
});
