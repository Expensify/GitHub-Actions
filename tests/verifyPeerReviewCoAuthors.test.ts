import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import VerifyPeerReview, {type PeerReviewCommit} from '../scripts/verifyPeerReview';
import createFakeGitHubUtils from './createFakeGitHubUtils';

function makeCommit(authorLogin: string | undefined, authorName: string | undefined, message: string, authorLoginsByEmail = new Map<string, string>()): PeerReviewCommit {
    return {
        sha: '11cfd67d458e0d97bd22d637aea32534d9666f12',
        author: authorLogin ? {login: authorLogin} : null,
        commit: {message, author: authorName ? {name: authorName} : {}},
        authorLoginsByEmail,
    };
}

const gitHubUtils = createFakeGitHubUtils({
    getCommitAuthorLoginsByEmail: async () => {
        throw new Error('Unexpected per-commit API call');
    },
    listPullRequestCommits: async () => {
        throw new Error('Unexpected commit-list API call');
    },
});

describe('getCommitAuthors', () => {
    it('counts co-authors for bot-authored commits without per-commit lookups', () => {
        const commit = makeCommit('MelvinBot', undefined, 'Change\n\nCo-authored-by: Andrew Gable <AndrewGable@users.noreply.github.com>');
        assert.deepEqual(VerifyPeerReview.getCommitAuthors(gitHubUtils, [commit], 'User'), ['AndrewGable', 'MelvinBot']);
    });

    it('ignores co-authors when canonical author is human', () => {
        const commit = makeCommit('rafecolton', undefined, 'Change\n\nCo-authored-by: Andrew Gable <AndrewGable@users.noreply.github.com>');
        assert.deepEqual(VerifyPeerReview.getCommitAuthors(gitHubUtils, [commit], 'User'), ['rafecolton']);
    });

    it('falls back to commit author name when github login is missing', () => {
        assert.deepEqual(VerifyPeerReview.getCommitAuthors(gitHubUtils, [makeCommit(undefined, 'AndrewGable', 'Change')], 'User'), ['AndrewGable']);
    });

    it('resolves non-noreply co-author emails from inline GitHub commit authors without per-commit lookups', () => {
        const commit = makeCommit(
            'MelvinBot',
            undefined,
            'Change\n\nCo-authored-by: RachCHopkins <rachael@expensify.com>\nCo-authored-by: Rachael Hopkins <RachCHopkins@users.noreply.github.com>',
            new Map([['rachael@expensify.com', 'RachCHopkins']]),
        );
        assert.deepEqual(VerifyPeerReview.getCommitAuthors(gitHubUtils, [commit], 'User'), ['MelvinBot', 'RachCHopkins']);
    });

    it('matches non-noreply co-author emails case-insensitively', () => {
        const commit = makeCommit('MelvinBot', undefined, 'Change\n\nCo-authored-by: John Smith <  Andrew@Expensify.com  >', new Map([['andrew@expensify.com', 'AndrewGable']]));
        assert.deepEqual(VerifyPeerReview.getCommitAuthors(gitHubUtils, [commit], 'User'), ['AndrewGable', 'MelvinBot']);
    });

    it('throws when GitHub does not match a non-noreply co-author email to a user', () => {
        const commit = makeCommit('MelvinBot', undefined, 'Change\n\nCo-authored-by: John Smith <andrew@expensify.com>', new Map([['infra+melvinbot@expensify.com', 'MelvinBot']]));
        assert.throws(() => VerifyPeerReview.getCommitAuthors(gitHubUtils, [commit], 'User'), /Unable to resolve co-author email to GitHub user: andrew@expensify.com/);
    });

    it('throws when GitHub lists no user for any co-author email', () => {
        const commit = makeCommit('MelvinBot', undefined, 'Change\n\nCo-authored-by: Jane Doe <jane.doe@gmail.com>');
        assert.throws(() => VerifyPeerReview.getCommitAuthors(gitHubUtils, [commit], 'User'), /Unable to resolve co-author email/);
    });

    it('throws when canonical author cannot be resolved', () => {
        assert.throws(() => VerifyPeerReview.getCommitAuthors(gitHubUtils, [makeCommit(undefined, undefined, 'Change')], 'User'), /Unable to resolve canonical commit author/);
    });
});
