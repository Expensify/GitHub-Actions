import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import type {GitHubPullRequestCommit} from '../scripts/libs/GitCommitUtils';
import VerifyPeerReview from '../scripts/verifyPeerReview';

function makeCommit(
    authorLogin: string | undefined,
    authorName: string | undefined,
    message: string,
    parents?: Array<{sha: string}>,
): GitHubPullRequestCommit {
    return {
        author: authorLogin ? {login: authorLogin} : null,
        commit: {
            message,
            author: authorName ? {name: authorName} : {},
        },
        parents,
    };
}

const EMPLOYEE_LOGINS = new Set(['AndrewGable', 'MelvinBot', 'rafecolton']);

describe('getCommitAuthors', () => {
    it('counts co-authors for bot-authored commits', async () => {
        const result = await VerifyPeerReview.getCommitAuthors(
            'Expensify',
            'Auth',
            [makeCommit('MelvinBot', undefined, 'Change\n\nCo-authored-by: Andrew Gable <AndrewGable@users.noreply.github.com>')],
            EMPLOYEE_LOGINS,
        );

        assert.deepEqual(result.authors, ['AndrewGable', 'MelvinBot']);
        assert.deepEqual(result.unresolvedExpensifyCoAuthors, []);
    });

    it('ignores co-authors when canonical author is human', async () => {
        const result = await VerifyPeerReview.getCommitAuthors('Expensify', 'Auth', [
            makeCommit('rafecolton', undefined, 'Change\n\nCo-authored-by: Andrew Gable <AndrewGable@users.noreply.github.com>'),
        ]);

        assert.deepEqual(result.authors, ['rafecolton']);
    });

    it('falls back to commit author name when github login is missing', async () => {
        const result = await VerifyPeerReview.getCommitAuthors('Expensify', 'Auth', [makeCommit(undefined, 'AndrewGable', 'Change')]);

        assert.deepEqual(result.authors, ['AndrewGable']);
    });

    it('normalizes expensify email casing and whitespace for unresolved detection', async () => {
        const result = await VerifyPeerReview.getCommitAuthors(
            'Expensify',
            'Auth',
            [makeCommit('MelvinBot', undefined, 'Change\n\nCo-authored-by: John Smith <  Andrew@Expensify.com  >')],
            EMPLOYEE_LOGINS,
        );

        assert.deepEqual(result.unresolvedExpensifyCoAuthors, ['Andrew@Expensify.com']);
    });

    it('resolves expensify co-authors from display name when email cannot be mapped', async () => {
        const result = await VerifyPeerReview.getCommitAuthors(
            'Expensify',
            'Auth',
            [makeCommit('MelvinBot', undefined, 'Change\n\nCo-authored-by: Andrew Gable <andrew@expensify.com>')],
            EMPLOYEE_LOGINS,
        );

        assert.deepEqual(result.authors, ['AndrewGable', 'MelvinBot']);
        assert.deepEqual(result.unresolvedExpensifyCoAuthors, []);
    });

    it('collects unresolved expensify co-author emails when display name cannot be mapped', async () => {
        const result = await VerifyPeerReview.getCommitAuthors(
            'Expensify',
            'Auth',
            [makeCommit('MelvinBot', undefined, 'Change\n\nCo-authored-by: John Smith <andrew@expensify.com>')],
            EMPLOYEE_LOGINS,
        );

        assert.deepEqual(result.unresolvedExpensifyCoAuthors, ['andrew@expensify.com']);
    });

    it('throws when canonical author cannot be resolved', async () => {
        await assert.rejects(() => VerifyPeerReview.getCommitAuthors('Expensify', 'Auth', [makeCommit(undefined, undefined, 'Change')]), /Unable to resolve canonical commit author/);
    });

    it('excludes merger from true git merge commits', async () => {
        const result = await VerifyPeerReview.getCommitAuthors('Expensify', 'App', [
            makeCommit('luacmartins', undefined, 'Merge branch main into feature', [{sha: 'a'}, {sha: 'b'}]),
            makeCommit('roryabraham', undefined, 'Actual change'),
        ]);

        assert.deepEqual(result.authors, ['roryabraham']);
    });

    it('expands authors from referenced PR for merge-message commits', async () => {
        const fetchPullRequestCommits = async () => [
            makeCommit('roryabraham', undefined, 'First change'),
            makeCommit('roryabraham', undefined, 'Second change'),
        ];

        const result = await VerifyPeerReview.getCommitAuthors(
            'Expensify',
            'App',
            [
                makeCommit('OSBotify', undefined, 'Bump version 1'),
                makeCommit('OSBotify', undefined, 'Bump version 2'),
                makeCommit('luacmartins', undefined, 'Merge pull request #94881 from Expensify/rory-94619-some-branch'),
            ],
            EMPLOYEE_LOGINS,
            undefined,
            fetchPullRequestCommits,
        );

        assert.deepEqual(result.authors, ['OSBotify', 'roryabraham']);
        assert.ok(!result.authors.includes('luacmartins'));
    });

    it('passes peer review when approver only merged cherry-picked PR', async () => {
        const fetchPullRequestCommits = async () => [makeCommit('roryabraham', undefined, 'Feature change')];

        const {authors, unresolvedExpensifyCoAuthors} = await VerifyPeerReview.getCommitAuthors(
            'Expensify',
            'App',
            [makeCommit('luacmartins', undefined, 'Merge pull request #94881 from Expensify/rory-branch')],
            EMPLOYEE_LOGINS,
            undefined,
            fetchPullRequestCommits,
        );

        const result = VerifyPeerReview.evaluatePeerReview({
            owner: 'Expensify',
            repo: 'App',
            number: 94887,
            baseRef: 'production',
            requiredApprovingReviewCount: 1,
            approvers: ['luacmartins'],
            authors,
            unresolvedExpensifyCoAuthors,
            employeeLogins: new Set(['luacmartins', 'roryabraham']),
        });

        assert.equal(result.status, 'pass');
    });
});
