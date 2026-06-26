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

const EMPLOYEE_LOGINS = new Set(['AndrewGable', 'MelvinBot', 'rafecolton']);

describe('getCommitAuthors', () => {
    it('counts co-authors for bot-authored commits', () => {
        const result = VerifyPeerReview.getCommitAuthors([makeCommit('MelvinBot', undefined, 'Change\n\nCo-authored-by: Andrew Gable <AndrewGable@users.noreply.github.com>')], EMPLOYEE_LOGINS);

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
        const result = VerifyPeerReview.getCommitAuthors(
            [makeCommit('MelvinBot', undefined, 'Change\n\nCo-authored-by: John Smith <  Andrew@Expensify.com  >')],
            EMPLOYEE_LOGINS,
        );

        assert.deepEqual(result.unresolvedExpensifyCoAuthors, ['Andrew@Expensify.com']);
    });

    it('resolves expensify co-authors from display name when email cannot be mapped', () => {
        const result = VerifyPeerReview.getCommitAuthors(
            [makeCommit('MelvinBot', undefined, 'Change\n\nCo-authored-by: Andrew Gable <andrew@expensify.com>')],
            EMPLOYEE_LOGINS,
        );

        assert.deepEqual(result.authors, ['AndrewGable', 'MelvinBot']);
        assert.deepEqual(result.unresolvedExpensifyCoAuthors, []);
    });

    it('collects unresolved expensify co-author emails when display name cannot be mapped', () => {
        const result = VerifyPeerReview.getCommitAuthors(
            [makeCommit('MelvinBot', undefined, 'Change\n\nCo-authored-by: John Smith <andrew@expensify.com>')],
            EMPLOYEE_LOGINS,
        );

        assert.deepEqual(result.unresolvedExpensifyCoAuthors, ['andrew@expensify.com']);
    });
});
