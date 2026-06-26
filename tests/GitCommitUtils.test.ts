import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import GitCommitUtils, {type GitHubPullRequestCommit} from '../scripts/libs/GitCommitUtils';

function makeCommit(authorLogin: string | undefined, authorName: string | undefined, message: string): GitHubPullRequestCommit {
    return {
        author: authorLogin ? {login: authorLogin} : null,
        commit: {
            message,
            author: authorName ? {name: authorName} : {},
        },
    };
}

describe('resolveNoreplyEmailToLogin', () => {
    it('parses standard noreply addresses', () => {
        assert.equal(GitCommitUtils.resolveNoreplyEmailToLogin('AndrewGable@users.noreply.github.com'), 'AndrewGable');
    });

    it('parses numeric noreply prefixes', () => {
        assert.equal(GitCommitUtils.resolveNoreplyEmailToLogin('2838819+AndrewGable@users.noreply.github.com'), 'AndrewGable');
    });
});

describe('parseCoAuthorEmails', () => {
    it('extracts multiple co-author emails', () => {
        const message = [
            'Some change',
            '',
            'Co-authored-by: Andrew Gable <AndrewGable@users.noreply.github.com>',
            'Co-authored-by: Monil Bhavsar <MonilBhavsar@users.noreply.github.com>',
        ].join('\n');

        assert.deepEqual(GitCommitUtils.parseCoAuthorEmails(message), ['AndrewGable@users.noreply.github.com', 'MonilBhavsar@users.noreply.github.com']);
    });
});

describe('parseCoAuthors', () => {
    it('extracts display names and emails', () => {
        const message = 'Change\n\nCo-authored-by: Andrew Gable <andrew@expensify.com>';

        assert.deepEqual(GitCommitUtils.parseCoAuthors(message), [{displayName: 'Andrew Gable', email: 'andrew@expensify.com'}]);
    });
});

describe('resolveDisplayNameToLogin', () => {
    it('parses github usernames from display names', () => {
        assert.equal(GitCommitUtils.resolveDisplayNameToLogin('AndrewGable'), 'AndrewGable');
    });

    it('removes spaces from display names', () => {
        assert.equal(GitCommitUtils.resolveDisplayNameToLogin('Andrew Gable'), 'AndrewGable');
    });

    it('returns null when display name cannot map to a github username', () => {
        assert.equal(GitCommitUtils.resolveDisplayNameToLogin("John O'Brien"), null);
    });
});

describe('resolveCoAuthorToLogin', () => {
    it('prefers noreply email resolution over display name', () => {
        assert.equal(
            GitCommitUtils.resolveCoAuthorToLogin({
                displayName: 'Wrong Name',
                email: 'AndrewGable@users.noreply.github.com',
            }),
            'AndrewGable',
        );
    });

    it('falls back to display name when email cannot be resolved', () => {
        assert.equal(
            GitCommitUtils.resolveCoAuthorToLogin({
                displayName: 'Andrew Gable',
                email: 'andrew@expensify.com',
            }),
            'AndrewGable',
        );
    });

    it('rejects display names that do not match allowed logins', () => {
        assert.equal(GitCommitUtils.resolveCoAuthorToLogin({displayName: 'John Smith', email: 'andrew@expensify.com'}, new Set(['AndrewGable'])), null);
    });

    it('uses canonical allowed login casing', () => {
        assert.equal(GitCommitUtils.resolveCoAuthorToLogin({displayName: 'andrew gable', email: 'andrew@expensify.com'}, new Set(['AndrewGable'])), 'AndrewGable');
    });
});

describe('getCanonicalAuthorLogin', () => {
    it('falls back to commit author name when github login is missing', () => {
        assert.equal(GitCommitUtils.getCanonicalAuthorLogin(makeCommit(undefined, 'AndrewGable', 'Change')), 'AndrewGable');
    });
});
