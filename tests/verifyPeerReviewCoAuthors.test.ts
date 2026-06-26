import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import type {GitHubPullRequestCommit} from '../scripts/libs/GitCommitUtils';
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

describe('getCommitAuthors', () => {
    it('counts co-authors for bot-authored commits', () => {
        const result = VerifyPeerReview.getCommitAuthors([makeCommit('MelvinBot', undefined, 'Change\n\nCo-authored-by: Andrew Gable <AndrewGable@users.noreply.github.com>')]);

        assert.deepEqual(result.authors, ['AndrewGable', 'MelvinBot']);
        assert.deepEqual(result.unresolvedExpensifyCoAuthors, []);
    });

    it('ignores co-authors when canonical author is human', () => {
        const result = VerifyPeerReview.getCommitAuthors([makeCommit('rafecolton', undefined, 'Change\n\nCo-authored-by: Andrew Gable <AndrewGable@users.noreply.github.com>')]);

        assert.deepEqual(result.authors, ['rafecolton']);
    });

    it('falls back to commit author name when github login is missing', () => {
        const result = VerifyPeerReview.getCommitAuthors([makeCommit(undefined, 'AndrewGable', 'Change')]);

        assert.deepEqual(result.authors, ['AndrewGable']);
    });

    it('normalizes expensify email casing and whitespace for unresolved detection', () => {
        const result = VerifyPeerReview.getCommitAuthors([makeCommit('MelvinBot', undefined, 'Change\n\nCo-authored-by: Andrew Gable <  Andrew@Expensify.com  >')]);

        assert.deepEqual(result.unresolvedExpensifyCoAuthors, ['Andrew@Expensify.com']);
    });

    it('collects unresolved expensify co-author emails', () => {
        const result = VerifyPeerReview.getCommitAuthors([makeCommit('MelvinBot', undefined, 'Change\n\nCo-authored-by: Andrew Gable <andrew@expensify.com>')]);

        assert.deepEqual(result.unresolvedExpensifyCoAuthors, ['andrew@expensify.com']);
    });
});
